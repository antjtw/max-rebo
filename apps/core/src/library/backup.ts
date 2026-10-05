import fs from 'node:fs';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import type { DB } from './db.ts';
import type { LibraryRepo, ProvenanceField } from './repo.ts';

/**
 * Library export/import (SPEC §8.7): every tag, field decision, feedback weight, rating and note,
 * keyed by content hash (and relative path as a fallback) so it survives a rebuilt database.
 */

interface ExportedTrack {
  hash: string;
  relPath: string;
  title: string;
  rating?: number | null;
  notes?: string | null;
  introSkipS?: number | null;
  rationale?: string | null;
  tags: { facet: string; value: string; source: string; confidence: number; status: string }[];
  fields: { field: string; value: string; source: string; confidence: number; status: string }[];
  weights: Record<string, number>;
}

export interface LibraryExport {
  version: 1;
  exportedAt: string;
  tracks: ExportedTrack[];
}

export function exportLibrary(repo: LibraryRepo): LibraryExport {
  const tracks: ExportedTrack[] = [];
  const weights = repo.db
    .prepare('SELECT track_id, scene_id, weight FROM track_scene_weights')
    .all() as {
    track_id: string;
    scene_id: string;
    weight: number;
  }[];
  const wmap = new Map<string, Record<string, number>>();
  for (const w of weights) {
    const m = wmap.get(w.track_id) ?? {};
    m[w.scene_id] = w.weight;
    wmap.set(w.track_id, m);
  }
  for (const t of repo.all()) {
    const tags = repo.tags(t.id);
    const fields = repo.fields(t.id);
    const w = wmap.get(t.id) ?? {};
    if (!tags.length && !fields.length && !Object.keys(w).length && t.rating == null && !t.notes)
      continue;
    tracks.push({
      hash: t.hash,
      relPath: t.rel_path,
      title: t.title,
      rating: t.rating,
      notes: t.notes,
      introSkipS: t.intro_skip_s,
      rationale: t.rationale,
      tags,
      fields,
      weights: w,
    });
  }
  return { version: 1, exportedAt: new Date().toISOString(), tracks };
}

export function writeBackup(repo: LibraryRepo, dir: string, label = ''): string {
  fs.mkdirSync(dir, { recursive: true });
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const file = path.join(dir, `library-${stamp}${label ? `-${label}` : ''}.yaml`);
  fs.writeFileSync(file, stringify(exportLibrary(repo), { lineWidth: 0 }));
  pruneBackups(dir, 30);
  return file;
}

function pruneBackups(dir: string, keep: number): void {
  const files = fs
    .readdirSync(dir)
    .filter((f) => /^library-\d{8}.*\.yaml$/.test(f))
    .sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) fs.rmSync(path.join(dir, f));
}

/** Restore from an export. Returns how many tracks were matched. Tracks must already be scanned. */
export function importLibrary(
  repo: LibraryRepo,
  data: LibraryExport,
): { matched: number; unmatched: number } {
  let matched = 0;
  let unmatched = 0;
  const db: DB = repo.db;
  db.transaction(() => {
    for (const e of data.tracks) {
      const row =
        (db.prepare('SELECT id FROM tracks WHERE hash = ? LIMIT 1').get(e.hash) as
          { id: string } | undefined) ??
        (repo.getByRelPath(e.relPath) ? { id: repo.getByRelPath(e.relPath)!.id } : undefined);
      if (!row) {
        unmatched++;
        continue;
      }
      matched++;
      const now = Date.now();
      for (const t of e.tags) {
        db.prepare(
          `INSERT OR REPLACE INTO track_tags(track_id, facet, value, source, confidence, status, updated_at) VALUES (?,?,?,?,?,?,?)`,
        ).run(row.id, t.facet, t.value, t.source, t.confidence, t.status, now);
      }
      for (const f of e.fields) {
        db.prepare(
          `INSERT OR REPLACE INTO track_fields(track_id, field, value, source, confidence, status, updated_at) VALUES (?,?,?,?,?,?,?)`,
        ).run(row.id, f.field, f.value, f.source, f.confidence, f.status, now);
        if (f.status !== 'rejected') {
          const field = f.field as ProvenanceField;
          const v =
            field === 'loopable' || field === 'diegetic'
              ? f.value === 'true' || f.value === '1'
                ? 1
                : 0
              : field === 'intensity'
                ? Number(f.value)
                : f.value;
          db.prepare(`UPDATE tracks SET ${field} = ? WHERE id = ?`).run(v, row.id);
        }
      }
      for (const [scene, w] of Object.entries(e.weights)) {
        db.prepare(
          'INSERT OR REPLACE INTO track_scene_weights(track_id, scene_id, weight) VALUES (?,?,?)',
        ).run(row.id, scene, w);
      }
      db.prepare(
        'UPDATE tracks SET rating = ?, notes = ?, intro_skip_s = COALESCE(?, intro_skip_s), rationale = COALESCE(?, rationale) WHERE id = ?',
      ).run(e.rating ?? null, e.notes ?? null, e.introSkipS ?? null, e.rationale ?? null, row.id);
    }
  })();
  return { matched, unmatched };
}

export function readBackup(file: string): LibraryExport {
  return parse(fs.readFileSync(file, 'utf8')) as LibraryExport;
}
