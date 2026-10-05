import { spawn } from 'node:child_process';
import { TagProposalFile, type TagProposal } from '@cantina/shared';
import type { LibraryRepo, TrackRow } from './repo.ts';
import { describeTrack } from './tagging.ts';

/**
 * Optional network/local enrichment providers (SPEC §8.4). Both are off by default and only
 * contact the destinations listed in SPEC §11.3.
 */

export const ACOUSTID_HOST = 'api.acoustid.org';

/** Chromaprint fingerprint via `fpcalc` (sends a fingerprint, never audio). */
export function fingerprint(file: string): Promise<{ duration: number; fingerprint: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn('fpcalc', ['-json', file], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (b: Buffer) => (out += b.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`fpcalc exited with ${code}`));
      try {
        resolve(JSON.parse(out) as { duration: number; fingerprint: string });
      } catch (e) {
        reject(e as Error);
      }
    });
  });
}

interface AcoustIdResponse {
  status: string;
  results?: {
    score: number;
    recordings?: {
      title?: string;
      artists?: { name: string }[];
      releasegroups?: { title?: string; type?: string }[];
    }[];
  }[];
}

/**
 * Look up a recording on AcoustID/MusicBrainz. The result enriches the track's metadata hints
 * (stored in notes for the tagger and reviewer); it never overwrites Ant's files.
 */
export async function acoustidLookup(
  file: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ title: string; album: string | null; artist: string | null; score: number } | null> {
  const fp = await fingerprint(file);
  const body = new URLSearchParams({
    client: apiKey,
    meta: 'recordings releasegroups',
    duration: String(Math.round(fp.duration)),
    fingerprint: fp.fingerprint,
  });
  const res = await fetchImpl(`https://${ACOUSTID_HOST}/v2/lookup`, {
    method: 'POST',
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`AcoustID HTTP ${res.status}`);
  const data = (await res.json()) as AcoustIdResponse;
  const best = data.results?.sort((a, b) => b.score - a.score)[0];
  const rec = best?.recordings?.[0];
  if (!best || !rec?.title) return null;
  return {
    title: rec.title,
    album: rec.releasegroups?.[0]?.title ?? null,
    artist: rec.artists?.map((a) => a.name).join(', ') ?? null,
    score: best.score,
  };
}

export async function runAcoustid(
  repo: LibraryRepo,
  apiKey: string,
  tracks: TrackRow[],
): Promise<number> {
  let n = 0;
  for (const t of tracks) {
    try {
      const r = await acoustidLookup(t.path, apiKey);
      if (r && r.score > 0.6) {
        const note = `MusicBrainz: ${r.artist ? `${r.artist} – ` : ''}${r.album ? `${r.album} – ` : ''}${r.title}`;
        repo.db
          .prepare(
            "UPDATE tracks SET notes = CASE WHEN notes IS NULL OR notes = '' THEN ? ELSE notes END WHERE id = ?",
          )
          .run(note, t.id);
        n++;
      }
      await new Promise((res) => setTimeout(res, 350)); // AcoustID rate limit: 3 requests/s
    } catch {
      // skip files that can't be fingerprinted or looked up
    }
  }
  return n;
}

/** Local LLM tagging (Ollama). Same proposal format as the Claude Code pass. */
export async function ollamaPropose(
  repo: LibraryRepo,
  tracks: TrackRow[],
  opts: { url: string; model: string; taxonomy: Record<string, string[]> },
  fetchImpl: typeof fetch = fetch,
): Promise<TagProposal[]> {
  const items = tracks.map((t) => describeTrack(repo, t));
  const prompt = [
    'You tag tabletop RPG background music and sound effects for a Star Wars-inspired game.',
    'For each track, propose tags using ONLY these values:',
    JSON.stringify(opts.taxonomy),
    'Never propose values listed under "rejected". Return ONLY a JSON array of objects:',
    '{"trackId": string, "proposed": {"kind"?, "scenes"?, "moods"?, "intensity"? (1-5), "settings"?, "factions"?, "category"?, "phase"?, "vocals"? ("none"|"choir"|"lyrics"), "loopable"?, "diegetic"?}, "confidence": 0-1, "rationale": string, "sources": string[]}',
    'Tracks:',
    JSON.stringify(items),
  ].join('\n');
  const res = await fetchImpl(`${opts.url.replace(/\/$/, '')}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      prompt,
      stream: false,
      format: 'json',
      options: { temperature: 0.2 },
    }),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
  const data = (await res.json()) as { response: string };
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.response);
  } catch {
    throw new Error('Ollama did not return JSON');
  }
  const list = Array.isArray(parsed)
    ? parsed
    : ((parsed as { proposals?: unknown; tracks?: unknown }).proposals ??
      (parsed as { tracks?: unknown }).tracks);
  const ok = TagProposalFile.safeParse(list);
  if (!ok.success) throw new Error('Ollama proposals did not match the schema');
  const allowed = new Set(tracks.map((t) => t.id));
  return ok.data
    .filter((p) => allowed.has(p.trackId))
    .map((p) => ({ ...p, confidence: Math.min(p.confidence, 0.6) }));
}
