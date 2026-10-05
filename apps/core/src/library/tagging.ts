import fs from 'node:fs';
import path from 'node:path';
import { TagProposalFile, type TagProposal, type TagSource } from '@cantina/shared';
import type { LibraryRepo, TrackRow } from './repo.ts';

/**
 * The tagging pass (SPEC §8.4). `tags:export` writes batches describing each track; a tagger
 * (Claude Code, or a local Ollama model) writes `batch-NNN.proposals.json`; `tags:import` loads
 * them as *inferred* tags with provenance. Nothing is applied as confirmed; Ant reviews.
 */

export interface ExportedTrackInfo {
  trackId: string;
  path: string;
  title: string;
  album: string | null;
  artist: string | null;
  trackNo: number | null;
  year: number | null;
  genre: string | null;
  durationS: number | null;
  kind: string;
  features: {
    lufs: number | null;
    energy: number | null;
    tempoBpm: number | null;
    onsetDensity: number | null;
    loopScore: number | null;
    vocalsScore: number | null;
  };
  currentTags: Record<string, string[]>;
  rejected: Record<string, string[]>;
  userConfirmed: Record<string, string[]>;
}

export function describeTrack(repo: LibraryRepo, t: TrackRow): ExportedTrackInfo {
  const tags = repo.tags(t.id);
  const group = (pred: (s: string) => boolean) => {
    const out: Record<string, string[]> = {};
    for (const tag of tags) if (pred(tag.status)) (out[tag.facet] ??= []).push(tag.value);
    return out;
  };
  return {
    trackId: t.id,
    path: t.rel_path,
    title: t.title,
    album: t.album,
    artist: t.artist,
    trackNo: t.track_no,
    year: t.year,
    genre: t.genre,
    durationS: t.duration_s != null ? Math.round(t.duration_s) : null,
    kind: t.kind,
    features: {
      lufs: t.lufs,
      energy: t.energy,
      tempoBpm: t.tempo_bpm,
      onsetDensity: t.onset_density,
      loopScore: t.loop_score,
      vocalsScore: t.vocals_score,
    },
    currentTags: group((s) => s === 'inferred'),
    rejected: group((s) => s === 'rejected'),
    userConfirmed: group((s) => s === 'confirmed'),
  };
}

/** Tracks this tagger hasn't proposed anything for yet. */
export function needsTagging(repo: LibraryRepo, t: TrackRow, source: TagSource): boolean {
  if (t.missing || t.bad) return false;
  const fromSource =
    repo.tags(t.id).some((x) => x.source === source) ||
    repo.fields(t.id).some((f) => f.source === source);
  return !fromSource;
}

export function exportBatches(
  repo: LibraryRepo,
  dir: string,
  opts: { batchSize?: number; all?: boolean; source?: TagSource } = {},
): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const size = opts.batchSize ?? 50;
  const source = opts.source ?? 'claude';
  const todo = repo.all().filter((t) => opts.all || needsTagging(repo, t, source));
  const existing = fs.readdirSync(dir).filter((f) => /^batch-\d+\.json$/.test(f));
  let n = existing.reduce((m, f) => Math.max(m, Number(/\d+/.exec(f)![0])), 0);
  const written: string[] = [];
  for (let i = 0; i < todo.length; i += size) {
    n++;
    const file = path.join(dir, `batch-${String(n).padStart(3, '0')}.json`);
    const tracks = todo.slice(i, i + size).map((t) => describeTrack(repo, t));
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          instructions:
            'Propose tags for each track and write them to the matching .proposals.json file. See docs/TAGGING.md for the format and taxonomy. Never repeat values listed under "rejected".',
          tracks,
        },
        null,
        2,
      ),
    );
    written.push(file);
  }
  return written;
}

export interface ImportResult {
  applied: number;
  skipped: number;
  errors: string[];
}

/** Apply proposals as inferred tags. User decisions and rejections always win (SPEC §8.5). */
export function importProposals(
  repo: LibraryRepo,
  proposals: TagProposal[],
  source: 'claude' | 'ollama',
): ImportResult {
  const res: ImportResult = { applied: 0, skipped: 0, errors: [] };
  repo.db.transaction(() => {
    for (const p of proposals) {
      const t = repo.get(p.trackId);
      if (!t) {
        res.skipped++;
        res.errors.push(`unknown track ${p.trackId}`);
        continue;
      }
      const c = p.confidence;
      const pr = p.proposed;
      for (const facet of [
        'scenes',
        'moods',
        'settings',
        'factions',
        'category',
        'phase',
      ] as const) {
        const v = pr[facet];
        if (v) repo.proposeFacet(t.id, facet, v, source, c);
      }
      if (pr.kind) repo.proposeField(t.id, 'kind', pr.kind, source, c);
      if (pr.intensity != null) repo.proposeField(t.id, 'intensity', pr.intensity, source, c);
      if (pr.vocals) repo.proposeField(t.id, 'vocals', pr.vocals, source, c);
      if (pr.loopable != null) repo.proposeField(t.id, 'loopable', pr.loopable, source, c);
      if (pr.diegetic != null) repo.proposeField(t.id, 'diegetic', pr.diegetic, source, c);
      const why = [p.rationale, p.sources.length ? `Sources: ${p.sources.join(', ')}` : '']
        .filter(Boolean)
        .join(' ');
      if (why) repo.setRationale(t.id, why);
      res.applied++;
    }
  })();
  return res;
}

export function importFile(
  repo: LibraryRepo,
  file: string,
  source: 'claude' | 'ollama',
): ImportResult {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  const list = Array.isArray(raw) ? raw : (raw as { proposals?: unknown }).proposals;
  const parsed = TagProposalFile.safeParse(list);
  if (!parsed.success) {
    return {
      applied: 0,
      skipped: 0,
      errors: parsed.error.issues
        .slice(0, 10)
        .map((i) => `${path.basename(file)} ${i.path.join('.')}: ${i.message}`),
    };
  }
  return importProposals(repo, parsed.data, source);
}

/** Import every `*.proposals.json` in the tagging directory not yet imported. */
export function importAll(
  repo: LibraryRepo,
  dir: string,
  source: 'claude' | 'ollama' = 'claude',
): ImportResult {
  const total: ImportResult = { applied: 0, skipped: 0, errors: [] };
  if (!fs.existsSync(dir)) return total;
  for (const f of fs
    .readdirSync(dir)
    .filter((x) => x.endsWith('.proposals.json'))
    .sort()) {
    const r = importFile(repo, path.join(dir, f), source);
    total.applied += r.applied;
    total.skipped += r.skipped;
    total.errors.push(...r.errors);
    if (!r.errors.length || r.applied)
      fs.renameSync(
        path.join(dir, f),
        path.join(dir, f.replace('.proposals.json', '.imported.json')),
      );
  }
  return total;
}
