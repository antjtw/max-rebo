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

- [x] Scanner (xxhash content identity, music-metadata, folder names), chokidar watcher, move detection, kind heuristics
- [x] Analysis: ebur128 loudness/true peak → gain offsets applied in the mixer; energy, waveform, silence/intro skip, onsets, tempo, loopability, vocals likelihood
- [x] SQLite schema and versioned migrations (DB copied to data/backups first); `library:export`/`library:import`; backup at the end of every session
- [x] Providers: heuristics (on), Claude Code tagging pass (`tags:export` → proposals → `tags:import`, see docs/TAGGING.md), AcoustID/MusicBrainz (`tags:acoustid`, opt-in), Ollama (`tags:ollama`, opt-in)
- [x] Provenance: user always wins, rejections remembered, implicit feedback weights
- [x] Library screen with review workflow, bulk confirm, inline tag editing, waveform, preview; Library health view
- [x] Scenes draw music by tag queries with fallbacks and gap reporting
- [ ] Ant's library scanned and analysed on the Mac; Claude Code tagging pass over every file; Ant reviews

## P4: Ears

- [x] Python ears service: binary protocol, VAD segmenter (Silero, energy fallback), Vosk grammar engine, Whisper (mlx / whisper.cpp), heartbeat; tested with fake engines
- [x] Core: supervisor with restart and heartbeat watchdog (DEGRADED meanwhile), 48→16 kHz resampler, opt-outs enforced before audio leaves the adapter, `/listen`, announcement, nickname indicator
- [x] Transcript panel (memory only, rolling 5 min), speaking blips
- [x] Local microphone adapter (avfoundation on macOS)
- [x] Simulator (UI screen and `npm run sim`); `npm run fixtures` (macOS `say`)
- [x] Custom vocabulary → Vosk grammar and Whisper prompt
- [ ] Real recognition on the Mac with models installed; latency on fixtures (needs the Mac)

## P5: Triggers

- [x] Trigger engine per §9 (patterns, fuzzy + phonetic, negation, questions, cooldowns, partial/final dedupe, subject resolution, per-player overrides, state and loops, self-hear guard)
- [x] Text-channel triggers
- [x] Triggers and Players screens with the live phrase tester
- [x] Scope callouts; latency in the event log
- [x] §16.2 scenario tests pass (`tests/scenarios/*.yaml`)
- [ ] Two-person Discord test (MANUAL-TESTS.md)

## P6: Scenes and game hooks

- [x] Scene scorer (decay, hysteresis, dwell, priority break-in, manual-only), modes, lock, suggestions, undo in Auto
- [x] Selection with feedback weights, recency, fallbacks, library gaps
- [x] Stings (on the SFX layer, ducking music by 10 dB)
- [x] MTFBWY hooks and Game panel; dice bot parsing (off until a bot is named, Q9)
- [ ] Optional Ollama scene classifier (MAY, off by default): not built; the hook is in place via `nudgeScene`
- [ ] Test session in Discord

## P7: Hardening and polish

- [x] launchd service (`npm run service:install`), caffeinate while in voice, graceful shutdown with backup
- [x] Robustness table (§14): reconnect backoff, DAVE 4017 message, ears restart, bad files skipped and marked, missing roots rechecked, invalid config refused with line numbers, rejoin after crash if the GM is still there
- [x] Accelerated soak (`npm run soak -- --hours 4`; a 20-minute version runs in `npm test`)
- [x] LAN/iPad mode with PIN and session cookie (tested)
- [x] Network allowlist test (§11.3)
- [x] README, screenshots (docs/screenshots), MANUAL-TESTS.md
- [ ] Real 3-hour session (Ant)

## Blocked / waiting on Ant

See `docs/HUMAN-TASKS.md`. All code phases are built; what remains needs the Mac, Discord, the real library or real voices.
