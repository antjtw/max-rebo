# Decisions log

ADR-style record of decisions and deviations from docs/SPEC.md. Newest at the bottom.
Format: date · decision · reason · alternatives considered.

---

## D-001 · 2026-10-05 · App name stays "Cantina"

- **Decision:** Use the §20 Q1 default. The GitHub repo is `max-rebo`, but the app, packages, wordmark and bot name are "Cantina" (`@cantina/*`).
- **Reason:** No answer to Q1. Renaming later is a find-and-replace on the wordmark and package scope.
- **Alternatives:** Rename everything to match the repo. "Max Rebo" is a real Star Wars character name, which §2 D11 and §11.4 steer away from in the UI.

## D-002 · 2026-10-05 · Single designated branch for cloud sessions

- **Decision:** This build runs in a Claude Code cloud session pinned to the branch `claude/new-session-2e3ryx`. Work for each phase is committed there with `Phase N:` prefixed messages instead of `phase/<n>-<slug>` branches.
- **Reason:** The cloud environment only permits pushing to the designated branch. Ant can merge it to `main` via a PR.
- **Alternatives:** Push phase branches (not permitted in this session).

## D-003 · 2026-10-05 · Defaults adopted for all open questions

- **Decision:** Every §20 question is unanswered, so all defaults apply: Apple Silicon, 16 GB+, `small.en` (Q2); `~/Music/Cantina` on the internal disk (Q3); 3–5 players with mixed headphones and a 300 ms self-hear guard (Q4); VAD-based segmentation (Q5); same Mac (Q6); LAN mode off (Q7); seeded vocabulary (Q8); dashboard dice buttons, text parsing off (Q9); players fire their own and generic SFX only (Q10); no lyrics in auto (Q11); Suggest mode (Q12); ducking on at −6 dB (Q13); 5-minute in-memory transcripts (Q14); Claude Code tagging pass plus heuristics (Q15); GM-only auto-join (Q16); one announcement channel, text triggers in the same channel (Q17); no posting beyond announcements (Q18); MTFBWY preset plus a generic hook interface (Q19); replace Kenku (Q20); saber ignite/hum/retract for James's character (Q21); §5.4 wording (Q22); no director's cut (Q23); leave only when no humans remain (Q24); QWERTY soundboard rows (Q25).
- **Reason:** §0 and §17.4.

## D-004 · 2026-10-05 · Core runs TypeScript directly under `tsx`

- **Decision:** `apps/core` and `packages/shared` are not compiled; `npm start` builds the dashboard and runs core with `tsx`. `tsc --noEmit` is the typecheck gate.
- **Reason:** One fewer build step and no source maps to manage for a single-user local tool. `tsx` start-up cost (~200 ms) is irrelevant here.
- **Alternatives:** `tsc` project references with `dist/` output; `tsup` bundling.

## D-005 · 2026-10-05 · zod v4

- **Decision:** Use zod 4 (current major) rather than zod 3.
- **Reason:** It is the maintained line; `prefault` makes nested config defaults concise.

## D-006 · 2026-10-05 · Ears speech engines are optional extras

- **Decision:** `ears/pyproject.toml` keeps the protocol, server, VAD wrapper and grammar logic dependency-light. Vosk, mlx-whisper / pywhispercpp, silero-vad (torch) and librosa are in the `speech` and `analysis` extras, installed by `npm run setup` on the Mac.
- **Reason:** Unit tests and CI must run without 1+ GB of models and Apple-only wheels. Engines are loaded lazily and report themselves in the heartbeat.

## D-007 · 2026-10-05 · Reference video not yet in the repo

- **Decision:** `docs/style/reference.mov` is absent, so no frames were extracted. The dashboard follows the written description in §12.1. `scripts/extract-frames.sh` extracts stills once the file is added.
- **Reason:** [HUMAN] task §19.1.1 not yet done.

## D-008 · 2026-10-05 · Dev dashboard on :5173, API on :4242

- **Decision:** `npm run dev` runs core (API, WebSocket, built dashboard) on `127.0.0.1:4242` and the Vite dev server with live reload on `127.0.0.1:5173`, proxying `/api` and `/ws` to core. `npm start` serves everything from `:4242`.
- **Reason:** Hot module reload needs Vite's own server; proxying Vite through Fastify adds a dependency for no user-visible gain.
- **Alternatives:** Vite middleware mode inside core; `@fastify/http-proxy`.

## D-009 · 2026-10-05 · Opus via opusscript, not @discordjs/opus

- **Decision:** Use `opusscript` (WASM/JS) for Opus encoding and decoding. `@discordjs/opus` is not installed.
- **Reason:** `@discordjs/opus`'s installer (`@discordjs/node-pre-gyp`) depends on `tar@6`, which has critical advisories with no fix in that range. Opus for one 48 kHz stereo output plus a handful of speakers is well within opusscript's budget on Apple Silicon.
- **Alternatives:** Install `@discordjs/opus` manually for lower CPU if profiling shows a need; `prism-media` picks it up automatically.

## D-010 · 2026-10-05 · `/listen all on|off` instead of `/listen on|off`

- **Decision:** The global switch is `/listen all on|off`; the personal opt-out stays `/listen me on|off`.
- **Reason:** Discord does not allow a command to mix subcommands with plain options, so `/listen on` and `/listen me on` cannot coexist on one command.
- **Alternatives:** Two commands (`/listen` and `/optout`); rejected as less discoverable.

## D-011 · 2026-10-05 · Audio analysis in TypeScript, not librosa

- **Decision:** Tempo, onset density, loopability and the vocals heuristic are computed in core (FFT over a 16 kHz mono decode) rather than in a librosa batch job in the ears environment. Loudness and true peak still come from FFmpeg `ebur128`.
- **Reason:** One fewer cross-process job; the features are coarse heuristics that feed review, not ground truth, so librosa's extra accuracy isn't needed. The `analysis` extra stays available if a better classifier is wanted later.

## D-012 · 2026-10-05 · A scene without `ambience` keeps the current beds

- **Decision:** Only scenes that declare `ambience` change the ambience layer. Others leave beds playing.
- **Reason:** Switching from Calm to Combat shouldn't stop the rain on the hull. Scenes that want silence can declare `ambience: { tracks: [] }`.

## D-013 · 2026-10-05 · Secondary text token `--line-mid`

- **Decision:** Added `--line-mid: #a3a3a9` for informational secondary text (≈ 7.5:1 on the panel colour). `--line-dim` is kept for borders and decoration, as §12.3 intends.
- **Reason:** The axe scan flagged 12 px `--line-dim` text (≈ 3.5:1) as failing AA; §12.3 requires informational text to pass AA.

## D-014 · 2026-10-05 · Voice join control lives in the header

- **Decision:** The dashboard's Join control (§5.2) is a compact dropdown in the header next to the health lamps rather than a panel.
- **Reason:** At 1440 × 900 a separate panel pushed scenes 8 and 9 out of view. The Voice lamp already shows connection state.

## D-015 · 2026-10-05 · Self-hear guard also applies after manual SFX

- **Decision:** For 300 ms after any SFX plays (trigger, soundboard or `/sfx`), speech triggers are ignored (Q4).
- **Reason:** Bleed from a manually fired sound is as likely to be mis-recognised as bleed from a triggered one.
