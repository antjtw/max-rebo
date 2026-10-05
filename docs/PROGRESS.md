# Progress

Phase checklist from SPEC §18. Updated at the end of every working session.
Legend: [x] done · [~] done in code, needs verification on the Mac / in Discord · [ ] not started

## P0: Foundations

- [x] Monorepo scaffold per §4.3 (npm workspaces, TS strict, ESLint + Prettier, Vitest)
- [x] Python ears package with uv, pytest and ruff
- [x] `packages/shared`: config, event, API and ears-protocol schemas
- [x] `scripts/setup-mac.sh`, `npm run setup`, `npm run doctor`
- [x] `.env.example`, `.gitignore`
- [x] `CLAUDE.md`, `docs/PROGRESS.md`, `docs/HUMAN-TASKS.md`, `docs/SETUP-DISCORD.md`, `docs/DECISIONS.md`
- [x] GitHub Actions: lint, typecheck, tests (Node and ears)
- [~] Done-when: fresh clone on the Mac runs `npm run setup && npm run doctor && npm test` (verified in the cloud container with `--ci`; needs a run on the Mac)

## P1: Voice out, mixer, DAVE spike

- [~] Discord login; all slash commands (§5.3); guild command registration (`npm run commands:register`)
- [x] Three-layer mixer: equal-power crossfades, ducking, lookahead limiter (unit-tested: never exceeds −1 dBFS)
- [~] Local speakers output (ffplay / AudioToolbox sink; needs a listen on the Mac)
- [x] Play a file into music; SFX over it without interruption (end-to-end test renders the mix)
- [~] DAVE receive spike: per-user Opus → PCM in memory → RMS → `voice.level` 10 Hz; blips on the Scope (needs Discord)
- [~] Auto-join / auto-leave (decision logic unit-tested; needs Discord)
- [~] Reconnection with 1–30 s backoff and a specific 4017/DAVE error (needs a Wi-Fi toggle test)

## P2: Console v1

- [x] Visual system (§12.3 tokens, self-hosted fonts), console layout, the Scope (frame, notch tension gauge, rings, chevrons, blips, callouts, level meter, microtext)
- [x] Panels: scenes (with live score bars), layers, now playing/queue, game, transcript, event log, soundboard, health lamps; keyboard shortcuts (§12.9)
- [x] Scenes with explicit track lists (play even before the library is scanned)
- [x] WebSocket live state; REST actions (§13)
- [x] Playwright smoke tests and axe scans pass on every screen (`npm run test:e2e`)
- [x] CRT toggles and reduced motion; usable at 1024 × 768 (scrolls)
- [~] Ant runs a session entirely from the browser

## P3: Library and tagging

- [ ] Scanner, watcher, hashing, metadata, kind heuristics
- [ ] Analysis jobs and gain offsets
- [ ] SQLite schema/migrations, backup/export/import
- [ ] Enrichment providers and Claude Code tagging pass
- [ ] Library screen, review workflow, Library health
- [ ] Scenes driven by tag queries

## P4: Ears

- [ ] Ears service: protocol, Vosk, Whisper, Silero VAD, heartbeat
- [ ] Core routing, opt-outs, `/listen`, announcement, nickname
- [ ] Transcript panel, speaking blips
- [ ] Local mic adapter
- [ ] Simulator (UI + CLI), fixtures
- [ ] Custom vocabulary

## P5: Triggers

- [ ] Trigger engine per §9
- [ ] Text-channel triggers
- [ ] Triggers and Players screens, phrase tester
- [ ] Scope callouts, latency in the event log

## P6: Scenes and game hooks

- [ ] Scene scorer, modes, lock, suggestions, undo
- [ ] Selection with feedback weights
- [ ] Stings
- [ ] MTFBWY hooks, Game panel, dice bot parsing
- [ ] Optional Ollama classifier

## P7: Hardening and polish

- [ ] launchd service, caffeinate, graceful shutdown
- [ ] Robustness table (§14)
- [ ] 4-hour soak
- [ ] LAN/iPad mode with PIN
- [ ] README, screenshots, MANUAL-TESTS.md

## Blocked / waiting on Ant

See `docs/HUMAN-TASKS.md`. Nothing is blocked yet.
