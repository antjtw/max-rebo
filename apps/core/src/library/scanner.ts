import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parseFile } from 'music-metadata';
import xxhash from 'xxhash-wasm';
import type { Kind } from '@cantina/shared';
import { AUDIO_EXTENSIONS, heuristicTags } from './heuristics.ts';
import type { LibraryRepo, ScannedFile, UpsertResult } from './repo.ts';

const MB = 1024 * 1024;
let hasherP: ReturnType<typeof xxhash> | null = null;

/**
 * Content hash: xxhash64 of the first and last 1 MB plus the size (SPEC §8.2). Fast on large
 * files and stable across renames, so moved files keep their tags.
 */
export async function contentHash(file: string, size?: number): Promise<string> {
  hasherP ??= xxhash();
  const { create64 } = await hasherP;
  const fh = await fsp.open(file, 'r');
  try {
    const st = size ?? (await fh.stat()).size;
    const h = create64();
    const head = Buffer.alloc(Math.min(MB, st));
    await fh.read(head, 0, head.length, 0);
    h.update(head);
    if (st > MB) {
      const tailLen = Math.min(MB, st - MB);
      const tail = Buffer.alloc(tailLen);
      await fh.read(tail, 0, tailLen, st - tailLen);
      h.update(tail);
    }
    h.update(Buffer.from(String(st)));
    return h.digest().toString(16).padStart(16, '0');
  } finally {
    await fh.close();
  }
}

export async function* walkAudio(root: string): AsyncGenerator<string> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) yield* walkAudio(p);
    else if (
      (e.isFile() || e.isSymbolicLink()) &&
      AUDIO_EXTENSIONS.has(path.extname(e.name).toLowerCase())
    )
      yield p;
  }
}

export interface ScanProgress {
  phase: 'scanning' | 'done' | 'error';
  progress: number;
  added: number;
  changed: number;
  removed: number;
  errors: number;
  message?: string;
}

export async function readFileInfo(file: string, root: string): Promise<ScannedFile> {
  const st = await fsp.stat(file);
  const hash = await contentHash(file, st.size);
  const relPath = path.relative(root, file).split(path.sep).join('/');
  const base = path.basename(file, path.extname(file));
  let meta: Awaited<ReturnType<typeof parseFile>> | null;
  try {
    meta = await parseFile(file, { duration: true, skipCovers: true });
  } catch {
    meta = null; // unreadable tags are fine; FFmpeg can still play most files
  }
  const c = meta?.common;
  return {
    path: file,
    root,
    relPath,
    hash,
    size: st.size,
    mtime: Math.floor(st.mtimeMs),
    title: c?.title?.trim() || base.replace(/^\d+[\s._-]+/, '').trim() || base,
    artist: c?.artist ?? null,
    album: c?.album ?? null,
    albumArtist: c?.albumartist ?? null,
    trackNo: c?.track?.no ?? null,
    year: c?.year ?? null,
    genre: c?.genre?.join(', ') ?? null,
    comment:
      c?.comment
        ?.map((x) => (typeof x === 'string' ? x : (x.text ?? '')))
        .join(' ')
        .slice(0, 500) || null,
    folder: path.dirname(relPath) === '.' ? null : path.dirname(relPath),
    durationS: meta?.format.duration ?? null,
    sampleRate: meta?.format.sampleRate ?? null,
    channels: meta?.format.numberOfChannels ?? null,
  };
}

/** Run the heuristic provider over a track (SPEC §8.4). Inferred only; user decisions win. */
export function applyHeuristics(repo: LibraryRepo, id: string): void {
  const t = repo.get(id);
  if (!t) return;
  const h = heuristicTags({
    relPath: t.rel_path,
    title: t.title,
    album: t.album,
    genre: t.genre,
    durationS: t.duration_s,
    energy: t.energy,
    onsetDensity: t.onset_density,
  });
  repo.proposeField(id, 'kind', h.kind.kind, 'heuristic', h.kind.confidence * 0.6);
  const conf = 0.35;
  for (const facet of ['scenes', 'moods', 'settings', 'category', 'phase', 'tags'] as const) {
    repo.proposeFacet(id, facet, h[facet], 'heuristic', conf);
  }
  if (h.intensity != null) repo.proposeField(id, 'intensity', h.intensity, 'heuristic', 0.3);
  if (t.loop_score != null && t.kind === 'ambience')
    repo.proposeField(id, 'loopable', t.loop_score > 0.6, 'heuristic', 0.4);
  if (t.vocals_score != null) {
    repo.proposeField(id, 'vocals', t.vocals_score > 0.6 ? 'lyrics' : 'none', 'heuristic', 0.3);
  }
}

/**
 * Scan library roots: add new files, update changed ones, detect moves by hash, mark missing ones.
 * Roots are read-only: nothing here writes to them (SPEC §8.1).
 */
export async function scanLibrary(
  repo: LibraryRepo,
  roots: string[],
  onProgress: (p: ScanProgress) => void = () => {},
): Promise<ScanProgress> {
  const available = roots.filter((r) => {
    try {
      return fs.statSync(r).isDirectory();
    } catch {
      return false;
    }
  });
  const files: [string, string][] = [];
  for (const root of available) for await (const f of walkAudio(root)) files.push([f, root]);
  const counts = { added: 0, changed: 0, removed: 0, errors: 0 };
  const seen = new Set<string>();
  let lastEmit = 0;
  for (let i = 0; i < files.length; i++) {
    const [file, root] = files[i]!;
    seen.add(file);
    try {
      const info = await readFileInfo(file, root);
      const kind: Kind = heuristicTags({
        relPath: info.relPath,
        title: info.title,
        durationS: info.durationS,
      }).kind.kind;
      const { id, result } = repo.upsertScanned(info, kind);
      tally(counts, result);
      if (result === 'added' || result === 'changed' || result === 'moved')
        applyHeuristics(repo, id);
    } catch {
      counts.errors++;
    }
    const now = Date.now();
    if (now - lastEmit > 250) {
      lastEmit = now;
      onProgress({ phase: 'scanning', progress: (i + 1) / files.length, ...counts });
    }
  }
  // Only roots that are currently available can have missing files; a missing drive is not a delete.
  counts.removed = repo.markMissingExcept(available, seen);
  const missingRoots = roots.filter((r) => !available.includes(r));
  const done: ScanProgress = {
    phase: 'done',
    progress: 1,
    ...counts,
    message: missingRoots.length ? `Unavailable roots: ${missingRoots.join(', ')}` : undefined,
  };
  onProgress(done);
  return done;
}

function tally(c: { added: number; changed: number }, r: UpsertResult): void {
  if (r === 'added') c.added++;
  else if (r === 'changed' || r === 'moved') c.changed++;
}

/** Single-file update for the watcher. */
export async function scanOne(
  repo: LibraryRepo,
  file: string,
  roots: string[],
): Promise<UpsertResult | 'removed' | null> {
  const root = roots.find((r) => file.startsWith(r + path.sep));
  if (!root || !AUDIO_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  if (!fs.existsSync(file)) {
    const t = repo.getByPath(file);
    if (t) repo.setMissing(t.id, true);
    return t ? 'removed' : null;
  }
  const info = await readFileInfo(file, root);
  const kind = heuristicTags({
    relPath: info.relPath,
    title: info.title,
    durationS: info.durationS,
  }).kind.kind;
  const { id, result } = repo.upsertScanned(info, kind);
  if (result !== 'unchanged') applyHeuristics(repo, id);
  return result;
}
