import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

/**
 * Versioned migrations (SPEC §8.7). Each runs once, in a transaction. A backup is written before
 * any migration runs on an existing database.
 */
export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE tracks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        root TEXT NOT NULL,
        rel_path TEXT NOT NULL,
        hash TEXT NOT NULL,
        size INTEGER NOT NULL,
        mtime REAL NOT NULL,
        title TEXT NOT NULL,
        artist TEXT, album TEXT, album_artist TEXT, track_no INTEGER, year INTEGER, genre TEXT,
        comment TEXT, folder TEXT,
        duration_s REAL, sample_rate INTEGER, channels INTEGER,
        kind TEXT NOT NULL DEFAULT 'music',
        lufs REAL, true_peak REAL, gain_db REAL, energy REAL, tempo_bpm REAL, onset_density REAL,
        intro_skip_s REAL, outro_trim_s REAL, loop_start_s REAL, loop_end_s REAL, loop_score REAL,
        vocals TEXT, vocals_score REAL, diegetic INTEGER, loopable INTEGER, intensity INTEGER,
        rating INTEGER, play_count INTEGER NOT NULL DEFAULT 0, last_played_at INTEGER,
        missing INTEGER NOT NULL DEFAULT 0, bad INTEGER NOT NULL DEFAULT 0, bad_reason TEXT,
        analysed_at INTEGER, analysis_version INTEGER NOT NULL DEFAULT 0,
        rationale TEXT, notes TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX tracks_path ON tracks(path);
      CREATE INDEX tracks_hash ON tracks(hash);
      CREATE INDEX tracks_kind ON tracks(kind);

      CREATE TABLE track_tags (
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        facet TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (track_id, facet, value)
      );
      CREATE INDEX track_tags_facet ON track_tags(facet, value);

      -- Scalar fields proposed by providers keep provenance too (kind, intensity, vocals...).
      CREATE TABLE track_fields (
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        field TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL,
        status TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (track_id, field)
      );

      CREATE TABLE track_scene_weights (
        track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
        scene_id TEXT NOT NULL,
        weight REAL NOT NULL,
        PRIMARY KEY (track_id, scene_id)
      );

      CREATE TABLE waveforms (
        track_id TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
        peaks BLOB NOT NULL
      );

      CREATE TABLE players (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT,
        display_name TEXT NOT NULL,
        character_name TEXT,
        aliases TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE sfx_overrides (
        player_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        track_id TEXT,
        path TEXT,
        PRIMARY KEY (player_id, trigger_id)
      );

      -- Event log: decisions only, never speech.
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE INDEX events_ts ON events(ts);
      CREATE INDEX events_type ON events(type);

      CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `,
  },
];

export interface OpenOptions {
  /** Called with the db path before migrating an existing database. */
  backup?: (dbPath: string, fromVersion: number) => void;
}

export function openDatabase(file: string, opts: OpenOptions = {}): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const existed = file !== ':memory:' && fs.existsSync(file);
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  migrate(db, existed ? opts.backup : undefined, file);
  return db;
}

export function schemaVersion(db: DB): number {
  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {
    v: number | null;
  };
  return row.v ?? 0;
}

export function migrate(
  db: DB,
  backup?: (dbPath: string, fromVersion: number) => void,
  file = '',
): number {
  const current = schemaVersion(db);
  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version,
  );
  if (pending.length && backup && current > 0) backup(file, current);
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)').run(
        m.version,
        Date.now(),
      );
    })();
  }
  return pending.length;
}
