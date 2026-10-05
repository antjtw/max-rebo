# Cantina

**Ambient acoustics console.** A private, local-first music and sound-effects bot for Discord tabletop sessions, with a live DJ console in the browser.

Cantina plays layered music, ambience and SFX into a Discord voice channel, listens (locally, in memory only) for cues like "I ignite my lightsaber", and gives the GM a CRT-style console to see and override everything.

- Full specification: [`docs/SPEC.md`](docs/SPEC.md)
- Build progress: [`docs/PROGRESS.md`](docs/PROGRESS.md)
- Things only you can do: [`docs/HUMAN-TASKS.md`](docs/HUMAN-TASKS.md)
- Decisions and deviations: [`docs/DECISIONS.md`](docs/DECISIONS.md)

## Quick start (macOS)

```sh
bash scripts/setup-mac.sh     # once: Homebrew, Node 22, Python 3.12, uv, FFmpeg
npm run setup                 # deps, speech models, .env, data/
# fill in .env and config/settings.yaml (docs/SETUP-DISCORD.md)
npm run doctor                # green/red checklist with fixes
npm run commands:register     # slash commands in your server
npm run dev                   # dashboard with live reload: http://127.0.0.1:5173
npm start                     # production: http://127.0.0.1:4242
```

## Privacy

- Speech recognition runs on your Mac. No audio or transcripts are written to disk, ever.
- Transcripts live in a rolling in-memory buffer (5 minutes by default) and only reach your local dashboard.
- Logs record decisions ("trigger saber-ignite matched for james"), never what was said.
- Players can opt out with `/listen me off`; their audio is then never sent to the recogniser.
- The dashboard binds to `127.0.0.1`. No telemetry. The only network destinations are listed in SPEC §11.3.

## Layout

| Path              | What                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| `apps/core`       | Node/TypeScript: Discord, mixer, library, trigger and scene engines, API |
| `apps/dashboard`  | React console                                                            |
| `ears`            | Python speech sidecar (Vosk + Whisper, memory only)                      |
| `packages/shared` | Schemas shared by everything (config, events, API)                       |
| `config`          | Human-edited YAML: settings, scenes, triggers, hooks, players            |
| `data`            | Gitignored: database, models, logs, backups                              |

## Quality gates

```sh
npm run lint && npm run typecheck && npm test
(cd ears && uv run pytest)
```
