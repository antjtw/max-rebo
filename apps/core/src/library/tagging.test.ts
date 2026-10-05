import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportLibrary, importLibrary } from './backup.ts';
import { openDatabase } from './db.ts';
import { ollamaPropose } from './providers.ts';
import { LibraryRepo } from './repo.ts';
import { exportBatches, importAll } from './tagging.ts';

let tmp = '';
afterEach(() => tmp && fs.rmSync(tmp, { recursive: true, force: true }));

function repoWith(n: number) {
  const repo = new LibraryRepo(openDatabase(':memory:'));
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      repo.upsertScanned(
        {
          path: `/lib/t${i}.mp3`,
          root: '/lib',
          relPath: `OST/t${i}.mp3`,
          hash: `h${i}`,
          size: 10 + i,
          mtime: 1,
          title: `Track ${i}`,
          album: 'OST',
          durationS: 120,
        },
        'music',
      ).id,
    );
  }
  return { repo, ids };
}

describe('Claude Code tagging pass', () => {
  it('exports batches and imports proposals as inferred tags with rationale', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-tag-'));
    const { repo, ids } = repoWith(5);
    repo.setUserTag(ids[0]!, 'moods', 'playful', 'rejected');
    const files = exportBatches(repo, tmp, { batchSize: 2 });
    expect(files.map((f) => path.basename(f))).toEqual([
      'batch-001.json',
      'batch-002.json',
      'batch-003.json',
    ]);
    const batch = JSON.parse(fs.readFileSync(files[0]!, 'utf8'));
    expect(batch.tracks[0].rejected).toEqual({ moods: ['playful'] });
    fs.writeFileSync(
      path.join(tmp, 'batch-001.proposals.json'),
      JSON.stringify([
        {
          trackId: ids[0],
          proposed: {
            scenes: ['combat'],
            moods: ['heroic', 'playful'],
            intensity: 4,
            vocals: 'none',
          },
          confidence: 0.78,
          rationale: 'Cue title suggests a starfighter battle.',
          sources: ['title', 'web: soundtrack cue listing'],
        },
      ]),
    );
    const r = importAll(repo, tmp);
    expect(r).toMatchObject({ applied: 1, skipped: 0 });
    const tags = repo.tags(ids[0]!);
    expect(tags.find((t) => t.value === 'combat')).toMatchObject({
      source: 'claude',
      status: 'inferred',
      confidence: 0.78,
    });
    expect(tags.find((t) => t.value === 'playful')?.status).toBe('rejected'); // rejection remembered
    expect(repo.get(ids[0]!)?.intensity).toBe(4);
    expect(repo.get(ids[0]!)?.rationale).toContain('starfighter');
    expect(fs.existsSync(path.join(tmp, 'batch-001.imported.json'))).toBe(true);
    // Re-export skips tracks the tagger has already seen.
    expect(exportBatches(repo, tmp, { batchSize: 100 })).toHaveLength(1);
  });

  it('reports schema errors without applying anything', () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cantina-tag-'));
    const { repo, ids } = repoWith(1);
    fs.writeFileSync(
      path.join(tmp, 'batch-001.proposals.json'),
      JSON.stringify([{ trackId: ids[0], proposed: { intensity: 9 }, confidence: 2 }]),
    );
    const r = importAll(repo, tmp);
    expect(r.applied).toBe(0);
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe('Ollama provider', () => {
  it('parses proposals and caps confidence', async () => {
    const { repo, ids } = repoWith(2);
    const fake = (async () =>
      new Response(
        JSON.stringify({
          response: JSON.stringify({
            proposals: [
              {
                trackId: ids[0],
                proposed: { scenes: ['calm'] },
                confidence: 0.95,
                rationale: 'quiet',
                sources: ['title'],
              },
              { trackId: 'trk_unknown', proposed: {}, confidence: 1 },
            ],
          }),
        }),
      )) as typeof fetch;
    const props = await ollamaPropose(
      repo,
      repo.all(),
      { url: 'http://127.0.0.1:11434', model: 'm', taxonomy: {} },
      fake,
    );
    expect(props).toHaveLength(1);
    expect(props[0]?.confidence).toBe(0.6);
  });
});

describe('library backup', () => {
  it('round-trips tags, weights and ratings into a fresh database by hash', () => {
    const a = repoWith(3);
    a.repo.setUserTag(a.ids[1]!, 'scenes', 'calm', 'confirmed');
    a.repo.proposeTag(a.ids[1]!, 'moods', 'serene', 'claude', 0.7);
    a.repo.setUserField(a.ids[1]!, 'intensity', 2);
    a.repo.adjustSceneWeight(a.ids[1]!, 'calm', 0.4);
    a.repo.applyPatch(a.ids[1]!, { rating: 5 });
    const dump = exportLibrary(a.repo);
    expect(dump.tracks).toHaveLength(1);
    const b = repoWith(3); // same files, new ids
    const r = importLibrary(b.repo, dump);
    expect(r).toEqual({ matched: 1, unmatched: 0 });
    const t = b.repo.get(b.ids[1]!)!;
    expect(t.intensity).toBe(2);
    expect(t.rating).toBe(5);
    expect(
      b.repo
        .tags(t.id)
        .map((x) => `${x.value}:${x.status}`)
        .sort(),
    ).toEqual(['calm:confirmed', 'serene:inferred']);
    expect(
      b.repo
        .candidates({ scenes: ['calm'] })
        .find((c) => c.track.id === t.id)
        ?.sceneWeights.get('calm'),
    ).toBe(0.4);
  });
});
