import crypto from 'node:crypto';
import fs from 'node:fs';
import type {
  Kind,
  LibraryPatch,
  TagRow,
  TagSource,
  TagStatus,
  TrackQuery,
  TrackSummary,
  Vocals,
} from '@cantina/shared';
import type { DB } from './db.ts';

/** Scalar track fields that carry provenance like tags do. */
export const PROVENANCE_FIELDS = ['kind', 'intensity', 'vocals', 'loopable', 'diegetic'] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

export interface TrackRow {
  id: string;
  path: string;
  root: string;
  rel_path: string;
  hash: string;
  size: number;
  mtime: number;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  track_no: number | null;
  year: number | null;
  genre: string | null;
  comment: string | null;
  folder: string | null;
  duration_s: number | null;
  sample_rate: number | null;
  channels: number | null;
  kind: Kind;
  lufs: number | null;
  true_peak: number | null;
  gain_db: number | null;
  energy: number | null;
  tempo_bpm: number | null;
  onset_density: number | null;
  intro_skip_s: number | null;
  outro_trim_s: number | null;
  loop_start_s: number | null;
  loop_end_s: number | null;
  loop_score: number | null;
  vocals: Vocals | null;
  vocals_score: number | null;
  diegetic: number | null;
  loopable: number | null;
  intensity: number | null;
  rating: number | null;
  play_count: number;
  last_played_at: number | null;
  missing: number;
  bad: number;
  bad_reason: string | null;
  analysed_at: number | null;
  analysis_version: number;
  rationale: string | null;
  notes: string | null;
  created_at: number;
  updated_at: number;
}

export interface ScannedFile {
  path: string;
  root: string;
  relPath: string;
  hash: string;
  size: number;
  mtime: number;
  title: string;
  artist?: string | null;
  album?: string | null;
  albumArtist?: string | null;
  trackNo?: number | null;
  year?: number | null;
  genre?: string | null;
  comment?: string | null;
  folder?: string | null;
  durationS?: number | null;
  sampleRate?: number | null;
  channels?: number | null;
}

export type UpsertResult = 'added' | 'changed' | 'moved' | 'unchanged';

/** A candidate for selection: a track plus its usable (non-rejected) tags. */
export interface Candidate {
  track: TrackRow;
  tags: Map<string, Map<string, { confidence: number; status: TagStatus }>>;
  sceneWeights: Map<string, number>;
}

const now = () => Date.now();

export function newTrackId(): string {
  return `trk_${crypto.randomBytes(5).toString('hex')}`;
}

/**
 * Library repository: the only code that touches the tracks/tags tables.
 * Provenance rules (SPEC §8.5): a `user` action always wins and is never overwritten by a provider;
 * rejected tags are remembered so providers can't propose them again.
 */
export class LibraryRepo {
  constructor(readonly db: DB) {}

  /* ------------------------------ tracks ------------------------------ */

  get(id: string): TrackRow | null {
    return (
      (this.db.prepare('SELECT * FROM tracks WHERE id = ?').get(id) as TrackRow | undefined) ?? null
    );
  }

  getByPath(p: string): TrackRow | null {
    return (
      (this.db.prepare('SELECT * FROM tracks WHERE path = ?').get(p) as TrackRow | undefined) ??
      null
    );
  }

  /** Find by path relative to a library root (as used in YAML config). */
  getByRelPath(rel: string): TrackRow | null {
    const norm = rel.replace(/^\.?\//, '');
    return (
      (this.db
        .prepare(
          'SELECT * FROM tracks WHERE rel_path = ? OR rel_path LIKE ? ORDER BY missing LIMIT 1',
        )
        .get(norm, `%/${norm}`) as TrackRow | undefined) ?? null
    );
  }

  all(): TrackRow[] {
    return this.db
      .prepare('SELECT * FROM tracks ORDER BY album, track_no, title')
      .all() as TrackRow[];
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM tracks').get() as { n: number }).n;
  }

  /**
   * Insert or update a scanned file. A file whose path is new but whose hash matches a track
   * that has gone missing is treated as a move, so its tags survive reorganisation (SPEC §8.1).
   */
  upsertScanned(
    f: ScannedFile,
    initialKind: Kind,
    exists: (p: string) => boolean = fs.existsSync,
  ): { id: string; result: UpsertResult } {
    const t = now();
    const existing = this.getByPath(f.path);
    if (existing) {
      const changed =
        existing.hash !== f.hash || existing.size !== f.size || existing.missing === 1;
      if (!changed && existing.mtime === f.mtime) return { id: existing.id, result: 'unchanged' };
      this.db
        .prepare(
          `UPDATE tracks SET hash=?, size=?, mtime=?, missing=0, title=?, artist=?, album=?, album_artist=?,
           track_no=?, year=?, genre=?, comment=?, folder=?, duration_s=?, sample_rate=?, channels=?,
           analysed_at = CASE WHEN hash = ? THEN analysed_at ELSE NULL END, updated_at=? WHERE id=?`,
        )
        .run(
          f.hash,
          f.size,
          f.mtime,
          f.title,
          f.artist ?? null,
          f.album ?? null,
          f.albumArtist ?? null,
          f.trackNo ?? null,
          f.year ?? null,
          f.genre ?? null,
          f.comment ?? null,
          f.folder ?? null,
          f.durationS ?? null,
          f.sampleRate ?? null,
          f.channels ?? null,
          f.hash,
          t,
          existing.id,
        );
      return { id: existing.id, result: changed ? 'changed' : 'unchanged' };
    }
    const sameContent = this.db
      .prepare('SELECT * FROM tracks WHERE hash = ? AND size = ? ORDER BY missing DESC')
      .all(f.hash, f.size) as TrackRow[];
    const moved = sameContent.find((t) => t.missing === 1 || !exists(t.path));
    if (moved) {
      this.db
        .prepare(
          'UPDATE tracks SET path=?, root=?, rel_path=?, folder=?, mtime=?, missing=0, updated_at=? WHERE id=?',
        )
        .run(f.path, f.root, f.relPath, f.folder ?? null, f.mtime, t, moved.id);
      return { id: moved.id, result: 'moved' };
    }
    const id = newTrackId();
    this.db
      .prepare(
        `INSERT INTO tracks (id, path, root, rel_path, hash, size, mtime, title, artist, album, album_artist,
         track_no, year, genre, comment, folder, duration_s, sample_rate, channels, kind, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        f.path,
        f.root,
        f.relPath,
        f.hash,
        f.size,
        f.mtime,
        f.title,
        f.artist ?? null,
        f.album ?? null,
        f.albumArtist ?? null,
        f.trackNo ?? null,
        f.year ?? null,
        f.genre ?? null,
        f.comment ?? null,
        f.folder ?? null,
        f.durationS ?? null,
        f.sampleRate ?? null,
        f.channels ?? null,
        initialKind,
        t,
        t,
      );
    return { id, result: 'added' };
  }

  /** Mark tracks under the given roots that weren't seen in a scan as missing. */
  markMissingExcept(roots: string[], seenPaths: Set<string>): number {
    const rows = this.db.prepare('SELECT id, path, root FROM tracks WHERE missing = 0').all() as {
      id: string;
      path: string;
      root: string;
    }[];
    const stmt = this.db.prepare('UPDATE tracks SET missing = 1, updated_at = ? WHERE id = ?');
    let n = 0;
    this.db.transaction(() => {
      for (const r of rows) {
        if (roots.includes(r.root) && !seenPaths.has(r.path)) {
          stmt.run(now(), r.id);
          n++;
        }
      }
    })();
    return n;
  }

  setMissing(id: string, missing: boolean): void {
    this.db
      .prepare('UPDATE tracks SET missing = ?, updated_at = ? WHERE id = ?')
      .run(missing ? 1 : 0, now(), id);
  }

  markBad(id: string, reason: string): void {
    this.db
      .prepare('UPDATE tracks SET bad = 1, bad_reason = ?, updated_at = ? WHERE id = ?')
      .run(reason, now(), id);
  }

  clearBad(id: string): void {
    this.db.prepare('UPDATE tracks SET bad = 0, bad_reason = NULL WHERE id = ?').run(id);
  }

  recordPlay(id: string, at = now()): void {
    this.db
      .prepare('UPDATE tracks SET play_count = play_count + 1, last_played_at = ? WHERE id = ?')
      .run(at, id);
  }

  setAnalysis(
    id: string,
    a: Partial<{
      lufs: number | null;
      true_peak: number | null;
      gain_db: number | null;
      energy: number | null;
      tempo_bpm: number | null;
      onset_density: number | null;
      intro_skip_s: number | null;
      outro_trim_s: number | null;
      loop_score: number | null;
      vocals_score: number | null;
      duration_s: number | null;
    }>,
    version: number,
  ): void {
    const keys = Object.keys(a);
    const sets = keys.map((k) => `${k} = @${k}`).join(', ');
    this.db
      .prepare(
        `UPDATE tracks SET ${sets}${sets ? ',' : ''} analysed_at = @at, analysis_version = @v WHERE id = @id`,
      )
      .run({ ...a, at: now(), v: version, id });
  }

  setWaveform(id: string, peaks: Uint8Array): void {
    this.db
      .prepare('INSERT OR REPLACE INTO waveforms(track_id, peaks) VALUES (?, ?)')
      .run(id, Buffer.from(peaks));
  }

  waveform(id: string): Uint8Array | null {
    const r = this.db.prepare('SELECT peaks FROM waveforms WHERE track_id = ?').get(id) as
      { peaks: Buffer } | undefined;
    return r ? new Uint8Array(r.peaks) : null;
  }

  /* ------------------------------- tags ------------------------------- */

  tags(trackId: string): TagRow[] {
    return this.db
      .prepare(
        'SELECT facet, value, source, confidence, status FROM track_tags WHERE track_id = ? ORDER BY facet, value',
      )
      .all(trackId) as TagRow[];
  }

  fields(
    trackId: string,
  ): { field: string; value: string; source: TagSource; confidence: number; status: TagStatus }[] {
    return this.db
      .prepare(
        'SELECT field, value, source, confidence, status FROM track_fields WHERE track_id = ?',
      )
      .all(trackId) as {
      field: string;
      value: string;
      source: TagSource;
      confidence: number;
      status: TagStatus;
    }[];
  }

  /**
   * A provider proposes a tag. Ignored if the user has acted on it (confirmed or rejected) or if a
   * stronger proposal from another provider exists.
   */
  proposeTag(
    trackId: string,
    facet: string,
    value: string,
    source: Exclude<TagSource, 'user'>,
    confidence: number,
  ): boolean {
    const v = value.trim().toLowerCase();
    if (!v) return false;
    const ex = this.db
      .prepare(
        'SELECT source, confidence, status FROM track_tags WHERE track_id=? AND facet=? AND value=?',
      )
      .get(trackId, facet, v) as
      { source: TagSource; confidence: number; status: TagStatus } | undefined;
    if (ex) {
      if (ex.source === 'user' || ex.status !== 'inferred') return false;
      if (ex.source !== source && ex.confidence > confidence) return false;
    }
    this.db
      .prepare(
        `INSERT INTO track_tags(track_id, facet, value, source, confidence, status, updated_at)
         VALUES (?,?,?,?,?, 'inferred', ?)
         ON CONFLICT(track_id, facet, value) DO UPDATE SET source=excluded.source, confidence=excluded.confidence,
         updated_at=excluded.updated_at`,
      )
      .run(trackId, facet, v, source, clamp01(confidence), now());
    return true;
  }

  /** Replace a provider's set of values for a facet: its stale inferred values are removed. */
  proposeFacet(
    trackId: string,
    facet: string,
    values: string[],
    source: Exclude<TagSource, 'user'>,
    confidence: number,
  ): void {
    const keep = new Set(values.map((v) => v.trim().toLowerCase()).filter(Boolean));
    this.db.transaction(() => {
      const stale = this.db
        .prepare(
          "SELECT value FROM track_tags WHERE track_id=? AND facet=? AND source=? AND status='inferred'",
        )
        .all(trackId, facet, source) as { value: string }[];
      const del = this.db.prepare(
        'DELETE FROM track_tags WHERE track_id=? AND facet=? AND value=?',
      );
      for (const s of stale) if (!keep.has(s.value)) del.run(trackId, facet, s.value);
      for (const v of keep) this.proposeTag(trackId, facet, v, source, confidence);
    })();
  }

  /** A user decision: always wins (SPEC §8.5). */
  setUserTag(trackId: string, facet: string, value: string, status: TagStatus): void {
    const v = value.trim().toLowerCase();
    this.db
      .prepare(
        `INSERT INTO track_tags(track_id, facet, value, source, confidence, status, updated_at)
         VALUES (?,?,?, 'user', 1, ?, ?)
         ON CONFLICT(track_id, facet, value) DO UPDATE SET source='user', confidence=1, status=excluded.status,
         updated_at=excluded.updated_at`,
      )
      .run(trackId, facet, v, status, now());
  }

  /** Confirm every inferred tag and field on a track (bulk review). */
  confirmAllInferred(trackId: string): void {
    const t = now();
    this.db
      .prepare(
        "UPDATE track_tags SET status='confirmed', source='user', confidence=1, updated_at=? WHERE track_id=? AND status='inferred'",
      )
      .run(t, trackId);
    this.db
      .prepare(
        "UPDATE track_fields SET status='confirmed', source='user', confidence=1, updated_at=? WHERE track_id=? AND status='inferred'",
      )
      .run(t, trackId);
  }

  /** A provider proposes a scalar field (kind, intensity, …). Applied unless the user has set it. */
  proposeField(
    trackId: string,
    field: ProvenanceField,
    value: string | number | boolean,
    source: Exclude<TagSource, 'user'>,
    confidence: number,
  ): boolean {
    const ex = this.db
      .prepare(
        'SELECT source, confidence, status, value FROM track_fields WHERE track_id=? AND field=?',
      )
      .get(trackId, field) as
      { source: TagSource; confidence: number; status: TagStatus; value: string } | undefined;
    const sv = String(value);
    if (ex) {
      if (ex.source === 'user' || ex.status !== 'inferred') return false;
      if (ex.source !== source && ex.confidence > confidence) return false;
    }
    this.db
      .prepare(
        `INSERT INTO track_fields(track_id, field, value, source, confidence, status, updated_at)
         VALUES (?,?,?,?,?, 'inferred', ?)
         ON CONFLICT(track_id, field) DO UPDATE SET value=excluded.value, source=excluded.source,
         confidence=excluded.confidence, status='inferred', updated_at=excluded.updated_at`,
      )
      .run(trackId, field, sv, source, clamp01(confidence), now());
    this.writeField(trackId, field, value);
    return true;
  }

  setUserField(
    trackId: string,
    field: ProvenanceField,
    value: string | number | boolean | null,
  ): void {
    if (value === null) {
      this.db.prepare('DELETE FROM track_fields WHERE track_id=? AND field=?').run(trackId, field);
      this.writeField(trackId, field, null);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO track_fields(track_id, field, value, source, confidence, status, updated_at)
         VALUES (?,?,?, 'user', 1, 'confirmed', ?)
         ON CONFLICT(track_id, field) DO UPDATE SET value=excluded.value, source='user', confidence=1,
         status='confirmed', updated_at=excluded.updated_at`,
      )
      .run(trackId, field, String(value), now());
    this.writeField(trackId, field, value);
  }

  private writeField(
    trackId: string,
    field: ProvenanceField,
    value: string | number | boolean | null,
  ): void {
    let v: string | number | null;
    if (value === null) v = null;
    else if (field === 'loopable' || field === 'diegetic')
      v = value === true || value === 'true' || value === 1 ? 1 : 0;
    else if (field === 'intensity') v = Number(value);
    else v = String(value);
    this.db
      .prepare(`UPDATE tracks SET ${field} = ?, updated_at = ? WHERE id = ?`)
      .run(v, now(), trackId);
  }

  setRationale(trackId: string, rationale: string): void {
    this.db.prepare('UPDATE tracks SET rationale = ? WHERE id = ?').run(rationale, trackId);
  }

  applyPatch(trackId: string, p: LibraryPatch): void {
    this.db.transaction(() => {
      if (p.kind !== undefined) this.setUserField(trackId, 'kind', p.kind);
      if (p.intensity !== undefined) this.setUserField(trackId, 'intensity', p.intensity);
      if (p.vocals !== undefined) this.setUserField(trackId, 'vocals', p.vocals);
      if (p.loopable !== undefined) this.setUserField(trackId, 'loopable', p.loopable);
      if (p.diegetic !== undefined) this.setUserField(trackId, 'diegetic', p.diegetic);
      if (p.rating !== undefined)
        this.db.prepare('UPDATE tracks SET rating=? WHERE id=?').run(p.rating, trackId);
      if (p.notes !== undefined)
        this.db.prepare('UPDATE tracks SET notes=? WHERE id=?').run(p.notes, trackId);
      if (p.introSkipS !== undefined)
        this.db.prepare('UPDATE tracks SET intro_skip_s=? WHERE id=?').run(p.introSkipS, trackId);
      for (const t of p.setTags ?? []) this.setUserTag(trackId, t.facet, t.value, t.status);
      if (p.confirmAllInferred) this.confirmAllInferred(trackId);
      this.db.prepare('UPDATE tracks SET updated_at=? WHERE id=?').run(now(), trackId);
    })();
  }

  /* ------------------------------ weights ----------------------------- */

  adjustSceneWeight(trackId: string, sceneId: string, delta: number): number {
    const cur =
      (
        this.db
          .prepare('SELECT weight FROM track_scene_weights WHERE track_id=? AND scene_id=?')
          .get(trackId, sceneId) as { weight: number } | undefined
      )?.weight ?? 0;
    const next = Math.max(-0.9, Math.min(3, cur + delta));
    this.db
      .prepare(
        `INSERT INTO track_scene_weights(track_id, scene_id, weight) VALUES (?,?,?)
         ON CONFLICT(track_id, scene_id) DO UPDATE SET weight=excluded.weight`,
      )
      .run(trackId, sceneId, next);
    return next;
  }

  /* ----------------------------- queries ------------------------------ */

  summary(row: TrackRow): TrackSummary {
    return {
      id: row.id,
      path: row.path,
      relPath: row.rel_path,
      title: row.title,
      album: row.album,
      artist: row.artist,
      durationS: row.duration_s,
      kind: row.kind,
      intensity: row.intensity,
      vocals: row.vocals,
      loopable: row.loopable == null ? null : row.loopable === 1,
      diegetic: row.diegetic == null ? null : row.diegetic === 1,
      gainDb: row.gain_db,
      lufs: row.lufs,
      energy: row.energy,
      rating: row.rating,
      missing: row.missing === 1 || row.bad === 1,
      tags: this.tags(row.id),
      rationale: row.rationale,
    };
  }

  /** Browse the library with simple filters (dashboard Library screen). */
  list(q: {
    q?: string;
    kind?: Kind;
    facet?: string;
    value?: string;
    status?: 'inferred' | 'confirmed' | 'needs_review';
    limit?: number;
    offset?: number;
  }): { total: number; rows: TrackRow[] } {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (q.q) {
      where.push('(title LIKE @q OR album LIKE @q OR artist LIKE @q OR rel_path LIKE @q)');
      params.q = `%${q.q}%`;
    }
    if (q.kind) {
      where.push('kind = @kind');
      params.kind = q.kind;
    }
    if (q.facet && q.value) {
      where.push(
        "id IN (SELECT track_id FROM track_tags WHERE facet=@facet AND value=@value AND status != 'rejected')",
      );
      params.facet = q.facet;
      params.value = q.value;
    }
    if (q.status === 'inferred' || q.status === 'needs_review') {
      where.push(
        "(id IN (SELECT track_id FROM track_tags WHERE status='inferred') OR id IN (SELECT track_id FROM track_fields WHERE status='inferred'))",
      );
    }
    if (q.status === 'confirmed') {
      where.push(
        "id NOT IN (SELECT track_id FROM track_tags WHERE status='inferred') AND id IN (SELECT track_id FROM track_tags WHERE status='confirmed')",
      );
    }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM tracks ${w}`).get(params) as { n: number }
    ).n;
    const rows = this.db
      .prepare(
        `SELECT * FROM tracks ${w} ORDER BY album, track_no, title LIMIT @limit OFFSET @offset`,
      )
      .all({ ...params, limit: q.limit ?? 500, offset: q.offset ?? 0 }) as TrackRow[];
    return { total, rows };
  }

  /**
   * Candidates for a scene's track query (SPEC §10.4 step 1). Facet filters are matched against
   * inferred and confirmed tags; rejected tags never match. Explicit `tracks` lists bypass tags.
   */
  candidates(query: TrackQuery, kinds: Kind[] = ['music']): Candidate[] {
    let rows: TrackRow[];
    if (query.tracks?.length) {
      rows = query.tracks
        .map((ref) => this.get(ref) ?? this.getByRelPath(ref) ?? this.getByPath(ref))
        .filter((r): r is TrackRow => !!r);
    } else {
      const ph = kinds.map(() => '?').join(',');
      rows = this.db
        .prepare(`SELECT * FROM tracks WHERE kind IN (${ph}) AND missing = 0 AND bad = 0`)
        .all(...kinds) as TrackRow[];
    }
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const tagMap = new Map<string, Candidate['tags']>();
    const weights = new Map<string, Map<string, number>>();
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const ph = chunk.map(() => '?').join(',');
      const tags = this.db
        .prepare(
          `SELECT track_id, facet, value, confidence, status FROM track_tags WHERE status != 'rejected' AND track_id IN (${ph})`,
        )
        .all(...chunk) as {
        track_id: string;
        facet: string;
        value: string;
        confidence: number;
        status: TagStatus;
      }[];
      for (const t of tags) {
        let m = tagMap.get(t.track_id);
        if (!m) tagMap.set(t.track_id, (m = new Map()));
        let f = m.get(t.facet);
        if (!f) m.set(t.facet, (f = new Map()));
        f.set(t.value, { confidence: t.confidence, status: t.status });
      }
      const ws = this.db
        .prepare(
          `SELECT track_id, scene_id, weight FROM track_scene_weights WHERE track_id IN (${ph})`,
        )
        .all(...chunk) as { track_id: string; scene_id: string; weight: number }[];
      for (const w of ws) {
        let m = weights.get(w.track_id);
        if (!m) weights.set(w.track_id, (m = new Map()));
        m.set(w.scene_id, w.weight);
      }
    }
    return rows.map((track) => ({
      track,
      tags: tagMap.get(track.id) ?? new Map(),
      sceneWeights: weights.get(track.id) ?? new Map(),
    }));
  }

  /** SFX matching a tag query such as { category: saber, phase: ignite }. */
  findSfx(q: { category?: string; phase?: string; kind?: string; tags?: string[] }): TrackRow[] {
    const kind = q.kind ?? 'sfx';
    const conds: string[] = ['kind = ?', 'missing = 0', 'bad = 0'];
    const params: unknown[] = [kind];
    const facetConds: [string, string][] = [];
    if (q.category) facetConds.push(['category', q.category]);
    if (q.phase) facetConds.push(['phase', q.phase]);
    for (const t of q.tags ?? []) facetConds.push(['tags', t]);
    for (const [facet, value] of facetConds) {
      conds.push(
        "id IN (SELECT track_id FROM track_tags WHERE facet = ? AND value = ? AND status != 'rejected')",
      );
      params.push(facet, value.toLowerCase());
    }
    return this.db
      .prepare(`SELECT * FROM tracks WHERE ${conds.join(' AND ')}`)
      .all(...params) as TrackRow[];
  }

  /* ------------------------------ events ------------------------------ */

  logEvent(ts: number, type: string, payload: unknown): void {
    this.db
      .prepare('INSERT INTO events(ts, type, payload) VALUES (?,?,?)')
      .run(ts, type, JSON.stringify(payload));
  }

  recentEvents(
    limit = 200,
    types?: string[],
  ): { id: number; ts: number; type: string; payload: unknown }[] {
    const rows = (
      types?.length
        ? this.db
            .prepare(
              `SELECT * FROM events WHERE type IN (${types.map(() => '?').join(',')}) ORDER BY id DESC LIMIT ?`,
            )
            .all(...types, limit)
        : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit)
    ) as { id: number; ts: number; type: string; payload: string }[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload) as unknown }));
  }

  /** Keep the event log bounded. */
  pruneEvents(keep = 50_000): void {
    this.db.prepare('DELETE FROM events WHERE id <= (SELECT MAX(id) FROM events) - ?').run(keep);
  }
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
