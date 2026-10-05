import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDatabase } from './db.ts';
import { guessKind, heuristicTags } from './heuristics.ts';
import { LibraryRepo } from './repo.ts';
import { contentHash, scanLibrary, scanOne } from './scanner.ts';

let root: string;

function tone(rel: string, seconds: number, freq = 440): string {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${freq}:duration=${seconds}`,
    '-metadata',
    `album=Test Album`,
    p,
  ]);
  return p;
}

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-lib-'));
  tone('Soundtracks/Test Album/01 Battle of the Rings.mp3', 25);
  tone('Soundtracks/Test Album/02 Peaceful Dawn.mp3', 25, 330);
  tone('SFX/Sabers/Kael - Crossguard Ignite.wav', 1.5, 880);
  tone('Ambience/Cantina Crowd Loop.wav', 21, 200);
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('heuristics', () => {
  it('guesses kinds from folders, names and duration', () => {
    expect(guessKind('SFX/door.wav', 2).kind).toBe('sfx');
    expect(guessKind('Ambience/rain loop.wav', 120).kind).toBe('ambience');
    expect(guessKind('Soundtracks/Album/01 Theme.mp3', 200).kind).toBe('music');
    expect(guessKind('misc/short.wav', 4).kind).toBe('sfx');
  });

  it('tags SFX category and phase, and music scenes', () => {
    const s = heuristicTags({
      relPath: 'SFX/Sabers/Kael - Crossguard Ignite.wav',
      title: 'Kael - Crossguard Ignite',
      durationS: 1.5,
    });
    expect(s.category).toContain('saber');
    expect(s.phase).toContain('ignite');
    const m = heuristicTags({
      relPath: 'OST/03 The Battle of Hoth.mp3',
      title: 'The Battle of Hoth',
      durationS: 300,
    });
    expect(m.scenes).toContain('combat');
    expect(m.settings).toContain('ice');
    expect(m.intensity).toBe(4);
  });
});

describe('scanLibrary', () => {
  it('scans, hashes, reads metadata and applies heuristics', async () => {
    const repo = new LibraryRepo(openDatabase(':memory:'));
    const res = await scanLibrary(repo, [root]);
    expect(res).toMatchObject({ added: 4, errors: 0, phase: 'done' });
    const saber = repo.getByRelPath('SFX/Sabers/Kael - Crossguard Ignite.wav')!;
    expect(saber.kind).toBe('sfx');
    expect(repo.findSfx({ category: 'saber', phase: 'ignite' }).map((t) => t.id)).toEqual([
      saber.id,
    ]);
    const battle = repo.getByRelPath('Soundtracks/Test Album/01 Battle of the Rings.mp3')!;
    expect(battle.album).toBe('Test Album');
    expect(battle.duration_s).toBeCloseTo(25, 0);
    expect(
      repo
        .tags(battle.id)
        .some((t) => t.facet === 'scenes' && t.value === 'combat' && t.status === 'inferred'),
    ).toBe(true);
    expect(repo.getByRelPath('Ambience/Cantina Crowd Loop.wav')?.kind).toBe('ambience');
    // Second scan: nothing changes.
    expect(await scanLibrary(repo, [root])).toMatchObject({ added: 0, changed: 0, removed: 0 });
  });

  it('keeps identity and tags when a file moves, and marks deletions missing', async () => {
    const repo = new LibraryRepo(openDatabase(':memory:'));
    await scanLibrary(repo, [root]);
    const before = repo.getByRelPath('Soundtracks/Test Album/02 Peaceful Dawn.mp3')!;
    repo.setUserTag(before.id, 'scenes', 'calm', 'confirmed');
    const from = path.join(root, 'Soundtracks/Test Album/02 Peaceful Dawn.mp3');
    const to = path.join(root, 'Soundtracks/Moved Dawn.mp3');
    fs.renameSync(from, to);
    const res = await scanLibrary(repo, [root]);
    expect(res.changed).toBe(1);
    const after = repo.getByPath(to)!;
    expect(after.id).toBe(before.id);
    expect(repo.tags(after.id).find((t) => t.value === 'calm')?.status).toBe('confirmed');
    fs.renameSync(to, from);
  });

  it('treats an unavailable root as a warning, not deletions', async () => {
    const repo = new LibraryRepo(openDatabase(':memory:'));
    await scanLibrary(repo, [root]);
    const res = await scanLibrary(repo, [root, '/nonexistent/drive']);
    expect(res.removed).toBe(0);
    expect(res.message).toContain('/nonexistent/drive');
  });

  it('updates single files for the watcher', async () => {
    const repo = new LibraryRepo(openDatabase(':memory:'));
    const f = tone('SFX/door open.wav', 1);
    expect(await scanOne(repo, f, [root])).toBe('added');
    fs.rmSync(f);
    expect(await scanOne(repo, f, [root])).toBe('removed');
  });

  it('hashes by content, not name', async () => {
    const a = path.join(root, 'SFX/Sabers/Kael - Crossguard Ignite.wav');
    const b = path.join(os.tmpdir(), `copy-${process.pid}.wav`);
    fs.copyFileSync(a, b);
    expect(await contentHash(a)).toBe(await contentHash(b));
    fs.rmSync(b);
  });
});
