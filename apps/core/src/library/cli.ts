/**
 * Library jobs (SPEC §15.2):
 *   npm run library:scan | library:analyse | library:export | library:import [file]
 *   npm run tags:export [-- --all] | tags:import [-- --source ollama]
 *   npm run tags:ollama            (optional local LLM pass, if enabled in settings)
 *   npm run tags:acoustid          (optional, needs ACOUSTID_API_KEY and fpcalc)
 * Library roots are read-only: nothing here writes to them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ConfigStore } from '../config/store.ts';
import { loadEnv } from '../env.ts';
import { CONFIG_DIR, dataDir } from '../paths.ts';
import { analyseLibrary } from './analyse.ts';
import { importLibrary, readBackup, writeBackup } from './backup.ts';
import { openDatabase } from './db.ts';
import { ollamaPropose, runAcoustid } from './providers.ts';
import { LibraryRepo } from './repo.ts';
import { scanLibrary } from './scanner.ts';
import { exportBatches, importAll, importProposals, needsTagging } from './tagging.ts';

const env = loadEnv();
const dir = dataDir(env);
const backups = path.join(dir, 'backups');
const taggingDir = path.join(dir, 'tagging');
const dbFile = path.join(dir, 'cantina.db');
const repo = new LibraryRepo(
  openDatabase(dbFile, {
    backup: (file) => {
      fs.mkdirSync(backups, { recursive: true });
      fs.copyFileSync(file, path.join(backups, `cantina-${Date.now()}.db`));
    },
  }),
);
const [cmd, ...args] = process.argv.slice(2);
const flag = (f: string) => args.includes(f);

function bar(p: number): string {
  const n = Math.round(p * 30);
  return `[${'#'.repeat(n)}${'.'.repeat(30 - n)}] ${Math.round(p * 100)}%`;
}

switch (cmd) {
  case 'scan': {
    if (!env.libraryRoots.length) {
      console.error('Set CANTINA_LIBRARY_PATHS in .env first.');
      process.exit(1);
    }
    const r = await scanLibrary(repo, env.libraryRoots, (p) =>
      process.stdout.write(`\r${bar(p.progress)}`),
    );
    console.log(
      `\nAdded ${r.added}, changed ${r.changed}, missing ${r.removed}, errors ${r.errors}. ${r.message ?? ''}`,
    );
    console.log(`Library: ${repo.count()} files.`);
    break;
  }
  case 'analyse': {
    const r = await analyseLibrary(repo, {
      onProgress: (p) => process.stdout.write(`\r${bar(p.progress)}`),
    });
    console.log(`\nAnalysed ${r.analysed}, errors ${r.errors}.`);
    break;
  }
  case 'export': {
    console.log(`Wrote ${writeBackup(repo, backups)}`);
    break;
  }
  case 'import': {
    const file =
      args.find((a) => !a.startsWith('--')) ??
      fs
        .readdirSync(backups)
        .filter((f) => f.endsWith('.yaml'))
        .sort()
        .map((f) => path.join(backups, f))
        .pop();
    if (!file) {
      console.error('No backup file given or found in data/backups.');
      process.exit(1);
    }
    const r = importLibrary(repo, readBackup(file));
    console.log(
      `Restored from ${file}: ${r.matched} tracks matched, ${r.unmatched} not in this library.`,
    );
    break;
  }
  case 'tags-export': {
    const files = exportBatches(repo, taggingDir, { all: flag('--all'), batchSize: 40 });
    console.log(
      files.length
        ? `Wrote ${files.length} batch file(s) to ${taggingDir}:\n${files.map((f) => `  ${path.basename(f)}`).join('\n')}`
        : 'Nothing needs tagging.',
    );
    if (files.length)
      console.log(
        '\nNext: ask Claude Code to tag them (docs/TAGGING.md), then run npm run tags:import.',
      );
    break;
  }
  case 'tags-import': {
    const source = args.includes('ollama') ? 'ollama' : 'claude';
    const r = importAll(repo, taggingDir, source);
    console.log(`Applied ${r.applied} proposal(s) as inferred tags, skipped ${r.skipped}.`);
    for (const e of r.errors.slice(0, 20)) console.error(`  ${e}`);
    break;
  }
  case 'tags-ollama': {
    const store = new ConfigStore(CONFIG_DIR);
    const cfg = store.loadAll();
    if (!cfg.settings.enrichment.ollama || !env.OLLAMA_URL) {
      console.error('Enable enrichment.ollama in config/settings.yaml and set OLLAMA_URL in .env.');
      process.exit(1);
    }
    const todo = repo.all().filter((t) => needsTagging(repo, t, 'ollama'));
    let applied = 0;
    for (let i = 0; i < todo.length; i += 10) {
      try {
        const props = await ollamaPropose(repo, todo.slice(i, i + 10), {
          url: env.OLLAMA_URL,
          model: cfg.settings.enrichment.ollamaModel,
          taxonomy: cfg.taxonomy,
        });
        applied += importProposals(repo, props, 'ollama').applied;
      } catch (err) {
        console.error(`batch ${i / 10 + 1}: ${(err as Error).message}`);
      }
      process.stdout.write(`\r${bar(Math.min(1, (i + 10) / todo.length))}`);
    }
    console.log(`\nOllama proposed tags for ${applied} track(s).`);
    break;
  }
  case 'tags-acoustid': {
    if (!env.ACOUSTID_API_KEY) {
      console.error('Set ACOUSTID_API_KEY in .env and enable enrichment.acoustid in settings.');
      process.exit(1);
    }
    const n = await runAcoustid(
      repo,
      env.ACOUSTID_API_KEY,
      repo.all().filter((t) => !t.missing && !t.notes),
    );
    console.log(`Identified ${n} recording(s) via AcoustID/MusicBrainz.`);
    break;
  }
  default:
    console.error(
      'Usage: cli.ts scan | analyse | export | import [file] | tags-export [--all] | tags-import [ollama] | tags-ollama | tags-acoustid',
    );
    process.exit(1);
}
repo.db.close();
