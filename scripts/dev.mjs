#!/usr/bin/env node
// `npm run dev`: core (which supervises ears) + dashboard with live reload.
// Core serves the API on http://127.0.0.1:4242; the Vite dev server (HMR) proxies to it on :5173.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const procs = [
  ['core', 'npx', ['tsx', 'watch', '--clear-screen=false', 'apps/core/src/main.ts']],
  ['dash', 'npm', ['run', 'dev', '-w', '@cantina/dashboard']],
];
const children = procs.map(([name, cmd, args]) => {
  const child = spawn(cmd, args, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  const tag = name === 'core' ? '\x1b[31m[core]\x1b[0m' : '\x1b[37m[dash]\x1b[0m';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (d) => {
      for (const line of d.toString().split('\n'))
        if (line.trim()) process.stdout.write(`${tag} ${line}\n`);
    });
  }
  child.on('exit', (code) => console.log(`${tag} exited (${code})`));
  return child;
});
console.log('Cantina dev: dashboard with live reload on http://127.0.0.1:5173 (API on :4242)');
const stop = () => {
  for (const c of children) c.kill('SIGINT');
  setTimeout(() => process.exit(0), 1500);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
