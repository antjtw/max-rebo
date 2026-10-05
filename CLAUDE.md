# CLAUDE.md: working rules for Cantina

Source of truth: docs/SPEC.md. Read it before any work. Progress: docs/PROGRESS.md.

## Rules

- Work phase by phase (SPEC §18). Branch per phase: phase/<n>-<slug>. Merge when acceptance criteria pass.
  (Cloud sessions may be pinned to a single designated branch instead; see docs/DECISIONS.md D-002.)
- Before merging: npm run lint && npm run typecheck && npm test (and `uv run pytest` in ears/).
- Unsettled decision → use SPEC §20 default, log it in docs/DECISIONS.md, continue.
- Ask the human only for [HUMAN] items or irreversible actions. Batch questions.
- NEVER commit: .env, config/players.yaml, data/, audio files, model files.
- NEVER write audio or transcripts to disk (tests excepted, in temp dirs). Log decisions, not speech.
- NEVER modify files in library roots.
- Network: only the destinations in SPEC §11.3.
- Update docs/PROGRESS.md at the end of every session.
- UI copy and docs in British English. Follow SPEC §12 for visuals; reference frames in docs/style/frames/.
- MTFBWY terms: "Focus" (never "spotlight"), "Despair", "Balance", "Dyad dice". MTFBWY has no initiative.

## Commands

npm run setup | doctor | dev | start | test | lint | typecheck | sim | fixtures | commands:register

## Layout notes

- `packages/shared`: zod schemas for config, events, API and the ears protocol. Consumed as TS source.
- `apps/core`: runs under `tsx` (no separate compile step). Pure logic (mixer DSP, trigger matcher,
  scene scorer, selection) is kept free of I/O so it can be unit-tested without Discord or FFmpeg.
- `apps/dashboard`: React + Vite; built to `apps/dashboard/dist` and served by core.
- `ears/`: Python 3.12 sidecar managed with uv. Heavy engines (vosk, mlx-whisper, silero) are
  optional extras so tests run without models.
