import { describe, expect, it } from 'vitest';
import { migrate, openDatabase, schemaVersion } from './db.ts';
import { LibraryRepo, type ScannedFile } from './repo.ts';

function file(over: Partial<ScannedFile> = {}): ScannedFile {
  return {
    path: '/lib/Soundtracks/Album/01 Battle.mp3',
    root: '/lib',
    relPath: 'Soundtracks/Album/01 Battle.mp3',
    hash: 'h1',
    size: 1000,
    mtime: 1,
    title: 'Battle',
    album: 'Album',
    durationS: 180,
    ...over,
  };
}

function repo() {
  return new LibraryRepo(openDatabase(':memory:'));
}

describe('migrations', () => {
  it('apply once and record the version', () => {
    const db = openDatabase(':memory:');
    expect(schemaVersion(db)).toBe(1);
    expect(migrate(db)).toBe(0);
  });
});

describe('LibraryRepo scanning', () => {
  it('adds, leaves unchanged and detects changes', () => {
    const r = repo();
    const a = r.upsertScanned(file(), 'music');
    expect(a.result).toBe('added');
    expect(r.upsertScanned(file(), 'music').result).toBe('unchanged');
    expect(r.upsertScanned(file({ hash: 'h2', mtime: 2 }), 'music')).toEqual({
      id: a.id,
      result: 'changed',
    });
  });

  it('matches a moved file by hash so tags survive', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.setUserTag(id, 'scenes', 'combat', 'confirmed');
    r.markMissingExcept(['/lib'], new Set());
    const moved = r.upsertScanned(
      file({ path: '/lib/Soundtracks/New/Battle.mp3', relPath: 'Soundtracks/New/Battle.mp3' }),
      'music',
    );
    expect(moved).toEqual({ id, result: 'moved' });
    expect(r.tags(id).map((t) => t.value)).toEqual(['combat']);
    expect(r.get(id)?.missing).toBe(0);
  });

  it('finds by relative path', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    expect(r.getByRelPath('Soundtracks/Album/01 Battle.mp3')?.id).toBe(id);
    expect(r.getByRelPath('Album/01 Battle.mp3')?.id).toBe(id);
  });
});

describe('provenance (SPEC §8.5)', () => {
  it('user actions always win over providers', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.setUserTag(id, 'scenes', 'calm', 'confirmed');
    expect(r.proposeTag(id, 'scenes', 'calm', 'claude', 0.99)).toBe(false);
    expect(r.tags(id)[0]).toMatchObject({ source: 'user', status: 'confirmed' });
  });

  it('remembers rejections so providers cannot re-propose them', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.proposeTag(id, 'moods', 'heroic', 'heuristic', 0.5);
    r.setUserTag(id, 'moods', 'heroic', 'rejected');
    expect(r.proposeTag(id, 'moods', 'heroic', 'claude', 0.9)).toBe(false);
    expect(r.tags(id)[0]?.status).toBe('rejected');
  });

  it('keeps the stronger of two provider proposals', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.proposeTag(id, 'scenes', 'combat', 'claude', 0.8);
    expect(r.proposeTag(id, 'scenes', 'combat', 'heuristic', 0.4)).toBe(false);
    expect(r.tags(id)[0]).toMatchObject({ source: 'claude', confidence: 0.8 });
  });

  it('replaces a provider facet set without touching user tags', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.proposeFacet(id, 'scenes', ['combat', 'chase'], 'claude', 0.7);
    r.setUserTag(id, 'scenes', 'boss', 'confirmed');
    r.proposeFacet(id, 'scenes', ['combat'], 'claude', 0.7);
    expect(
      r
        .tags(id)
        .map((t) => t.value)
        .sort(),
    ).toEqual(['boss', 'combat']);
  });

  it('applies field proposals unless the user has set the field', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.proposeField(id, 'intensity', 4, 'claude', 0.7);
    expect(r.get(id)?.intensity).toBe(4);
    r.setUserField(id, 'intensity', 2);
    expect(r.proposeField(id, 'intensity', 5, 'claude', 0.9)).toBe(false);
    expect(r.get(id)?.intensity).toBe(2);
  });

  it('bulk-confirms inferred tags', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.proposeFacet(id, 'scenes', ['combat', 'chase'], 'claude', 0.7);
    r.applyPatch(id, { confirmAllInferred: true });
    expect(r.tags(id).every((t) => t.status === 'confirmed')).toBe(true);
    expect(r.list({ status: 'needs_review' }).total).toBe(0);
  });
});

describe('queries', () => {
  it('returns candidates with tags, excluding rejected ones', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    r.proposeTag(id, 'scenes', 'combat', 'claude', 0.8);
    r.setUserTag(id, 'scenes', 'calm', 'rejected');
    const [c] = r.candidates({ scenes: ['combat'] });
    expect(c?.tags.get('scenes')?.has('combat')).toBe(true);
    expect(c?.tags.get('scenes')?.has('calm')).toBe(false);
  });

  it('resolves explicit track lists by relative path', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    expect(r.candidates({ tracks: ['Album/01 Battle.mp3'] }).map((c) => c.track.id)).toEqual([id]);
  });

  it('finds SFX by category and phase', () => {
    const r = repo();
    const { id } = r.upsertScanned(
      file({ path: '/lib/SFX/ignite.wav', relPath: 'SFX/ignite.wav', hash: 'x' }),
      'sfx',
    );
    r.proposeTag(id, 'category', 'saber', 'heuristic', 0.6);
    r.proposeTag(id, 'phase', 'ignite', 'heuristic', 0.6);
    expect(r.findSfx({ category: 'saber', phase: 'ignite' }).map((t) => t.id)).toEqual([id]);
    expect(r.findSfx({ category: 'saber', phase: 'retract' })).toEqual([]);
  });

  it('clamps feedback weights', () => {
    const r = repo();
    const { id } = r.upsertScanned(file(), 'music');
    for (let i = 0; i < 20; i++) r.adjustSceneWeight(id, 'combat', -0.2);
    expect(r.adjustSceneWeight(id, 'combat', 0)).toBe(-0.9);
  });
});
