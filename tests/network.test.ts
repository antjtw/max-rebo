import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../apps/core/src/paths.ts';

/**
 * SPEC §11.3: Cantina contacts only Discord, model/package hosts during setup, AcoustID/MusicBrainz
 * when enabled, and a local Ollama. This test scans every runtime source file for hard-coded
 * hosts and fails on anything else, and checks the dashboard makes no external requests.
 */
const ALLOWED = [
  'discord.com', // gateway/REST (doctor), via discord.js
  'api.acoustid.org', // opt-in provider
  '127.0.0.1',
  'localhost',
  'alphacephei.com', // Vosk model download, setup only
  'raw.githubusercontent.com', // Homebrew installer, setup-mac.sh only
  'github.com', // docs links
  'discord.js.org',
  'docs.discord.com',
  'www.apple.com', // plist DTD identifier, not fetched
  'www.w3.org', // SVG xmlns identifier, not fetched
];

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      ['node_modules', 'dist', '.venv', 'data', 'test-results', 'playwright-report'].includes(
        e.name,
      )
    )
      continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mjs|js|py|sh|html|css)$/.test(e.name) && !/\.test\.|\.spec\./.test(e.name))
      out.push(p);
  }
  return out;
}

describe('network allowlist (SPEC §11.3)', () => {
  const files = [
    ...walk(path.join(REPO_ROOT, 'apps')),
    ...walk(path.join(REPO_ROOT, 'ears', 'ears')),
    ...walk(path.join(REPO_ROOT, 'scripts')),
  ];

  it('only references allowed hosts', () => {
    const bad: string[] = [];
    for (const f of files) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:https?|wss?):\/\/([a-z0-9.-]+)/gi)) {
        const host = m[1]!.toLowerCase();
        if (!ALLOWED.some((a) => host === a || host.endsWith(`.${a}`)))
          bad.push(`${path.relative(REPO_ROOT, f)}: ${host}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the dashboard loads no external fonts, scripts or styles', () => {
    const dash = files.filter((f) => f.includes(`${path.sep}dashboard${path.sep}`));
    for (const f of dash) {
      const text = fs.readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/fonts\.googleapis|cdn\.|unpkg|jsdelivr/);
    }
  });

  it('runtime fetch calls are limited to Discord, AcoustID, Ollama and the local core', () => {
    const calls: string[] = [];
    for (const f of files.filter((x) => /\.(ts|tsx)$/.test(x))) {
      const text = fs.readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?<![.\w])fetch(?:Impl)?\(\s*([^,)]+)/g))
        calls.push(`${path.relative(REPO_ROOT, f)}: ${m[1]!.trim().slice(0, 60)}`);
    }
    const unexpected = calls.filter(
      (c) =>
        !/discord\.com|ACOUSTID_HOST|opts\.url|127\.0\.0\.1|method, url|url\b|base \+ url|spec\)/.test(
          c,
        ),
    );
    expect(unexpected).toEqual([]);
  });
});
