# CANTINA: Specification

**A private, local-first, context-aware music and sound-effects bot for Discord tabletop sessions, with a live DJ console in the browser.**

| | |
|---|---|
| Codename | `cantina` (rename freely; see §20, Q1) |
| Owner | Ant (anthony@antjtw.com) |
| Builder | Claude Code, working autonomously, phase by phase |
| Host machine | Ant's Mac (macOS "Golden Gate", the current release) |
| Status | v1.0 of this spec, 5 October 2026 |
| Spec location in repo | `docs/SPEC.md` (this file) |

---

## 0. How to use this document

This is the single source of truth for the build. It is written so that Claude Code can pick it up and work through it with minimal hand-holding.

- **Claude Code:** read all of this file before writing any code. Then follow §17 (working agreement) and §18 (phases) in order. Every decision that is not explicitly settled here has a **default** in §20. Use the default, record it in `docs/DECISIONS.md`, and keep going. Stop and ask only for the items marked **[HUMAN]**.
- **Ant:** the things only you can do are collected in §19 (human tasks). The open questions are in §20, each with the default that will be used if you don't answer.

Keywords: **MUST** means required for that phase to be done. **SHOULD** means strongly expected unless there's a recorded reason. **MAY** means optional or stretch.

---

## 1. Vision

When the table says "I ignite my lightsaber", a lightsaber ignites. When James says it, *James's* lightsaber ignites. When the party gets ambushed, the music shifts into combat without anyone touching anything. When the GM wants control back, one click in a console that looks like it was pulled from an Imperial shipyard terminal gives it to them.

Cantina is Kenku FM with ears and a brain: a Discord bot that plays layered music, ambience and sound effects into a voice channel, a local speech pipeline that understands what is happening at the table, and a browser dashboard where Ant sees everything live and DJs by hand whenever he wants.

### 1.1 Goals

1. **Atmosphere without admin.** The GM should be able to run a whole session without touching the music, yet override anything instantly.
2. **Private by construction.** Nobody's voice leaves the Mac except through Discord itself. No audio or transcripts are written to disk. No cloud speech services. No telemetry.
3. **Personal.** Sound effects can be mapped to specific players and characters.
4. **Robust.** Survives disconnects, crashes in the speech worker, missing files, and four-hour sessions. Falls back gracefully to manual control.
5. **Learns from use.** Tags start as inferred guesses and are confirmed or corrected over time; manual overrides feed back into future choices.
6. **A joy to look at.** A CRT-style, red-and-white wireframe console (§12).

### 1.2 Non-goals (v1)

- Streaming from Spotify, YouTube or any online music service. Local files only.
- Hosting in the cloud or serving more than one Discord server at once.
- Recording sessions, storing transcripts, or producing session summaries.
- Public distribution of the bot. This is a personal tool for one group.
- Mobile app. (The dashboard SHOULD work on an iPad browser on the local network; see §12.10.)

### 1.3 Success criteria for v1

- A full session (3+ hours) runs with Auto or Suggest mode on, with no crash and no manual restart.
- Personal SFX triggers fire within **1.5 s** of the phrase ending, at least **9 out of 10** times in a real session, with fewer than **one false trigger per hour**.
- Scene changes feel right to the GM at least 80% of the time in Suggest mode (measured by accept vs dismiss in the event log).
- The library of Ant's existing files is tagged well enough to drive scenes, with every inferred tag reviewable in the dashboard.

---

## 2. Key decisions (settled)

| # | Decision | Why |
|---|---|---|
| D1 | **Private GitHub repo, cloned and run on the Mac.** | Version history, a safe backup, easy `git pull` of updates, and Claude Code can work in it. Running locally keeps everything private and gives access to the audio files. |
| D2 | **Audio files never go in the repo.** They live in a folder on the Mac (or an external drive); the app points at it via config. | Size, copyright, privacy. |
| D3 | **Node.js + TypeScript for the bot, mixer, engine and API server.** `discord.js` v14 + `@discordjs/voice`. | The most mature Discord voice stack with DAVE support (§3.1). |
| D4 | **Python sidecar ("ears") for speech recognition.** Vosk for fast keyword spotting, Whisper (Apple Silicon optimised) for richer transcripts. | Best local speech tooling lives in Python. Isolating it means a crash in speech never takes the music down. |
| D5 | **React + Vite + TypeScript dashboard**, served by the core on `http://127.0.0.1:4242`. | Fast, well-known, plays well with Canvas/SVG for the scope visual. |
| D6 | **SQLite** (`better-sqlite3`) for the library and settings; **YAML** for human-edited config (scenes, triggers, players). | Zero-ops, fast, portable; YAML is easy to hand-edit and diff. |
| D7 | **FFmpeg** for decoding and analysis. | Handles WAV, MP3 and anything else Ant throws at it. |
| D8 | **Three-layer mixer in the core**: Music, Ambience, SFX, mixed into a single stream to Discord. | SFX must play over music without interrupting it. |
| D9 | **Input and output are adapters.** Input: Discord voice, Discord text, local microphone, simulator. Output: Discord voice, local speakers. | Testable without Discord; also works at an in-person table. |
| D10 | **Three automation modes: Manual, Suggest, Auto.** Default is **Suggest**. | Builds trust before handing over control. |
| D11 | **Original visual identity.** Star Wars–*inspired* styling, but no Lucasfilm logos, wordmarks or real in-universe manufacturer names in the UI. | Keeps the project clean; the reference video's "Sienar Fleet Systems" mark is replaced with an invented one (§12.2). |

---

## 3. Platform constraints and facts

### 3.1 Discord voice and DAVE

- Since **1 March 2026**, Discord only allows end-to-end encrypted voice (its **DAVE** protocol) in DMs, group DMs, voice channels and Go Live. Clients or bots without DAVE support are refused (voice gateway close code `4017`). Stage channels are the only exception.
- `@discordjs/voice` requires **Node.js 22.12.0 or newer** and ships with `@snazzah/davey` as its DAVE implementation.
- **Receiving audio is not officially documented by Discord**, and `@discordjs/voice` says stable receive support isn't guaranteed. This is the single biggest technical risk; Phase 1 includes a spike to prove it works (§18, P1).
- Receive gives **one Opus stream per speaking user**, keyed by SSRC and mapped to a Discord user ID. That's what makes per-player triggers possible.

### 3.2 macOS

- Ant is on the current macOS release. Assume **Apple Silicon** unless told otherwise (§20, Q2). On Apple Silicon, use Metal/MLX-accelerated Whisper; on Intel, fall back to CPU `whisper.cpp` with a smaller model.
- The Mac MUST NOT sleep during a session. The app SHOULD run under `caffeinate` while a session is active (§15.4).
- Microphone access (for the local-mic input adapter) needs macOS permission for Terminal or whichever app launches Cantina.

### 3.3 Files

- Input formats: **WAV and MP3 required**; FLAC, OGG, M4A/AAC and AIFF SHOULD work for free via FFmpeg.
- Ant's files are currently **untagged** (beyond whatever ID3 tags the albums already carry) and are a mix of soundtracks and sound effects.

---

## 4. Architecture

```
                         ┌───────────────────────────── Ant's Mac ─────────────────────────────┐
                         │                                                                      │
 Discord voice  ◀──────▶ │  CORE (Node/TS)                                                      │
 (DAVE E2EE)             │  ├─ discord adapter ── voice in (per-user Opus) / voice out (mix)    │
                         │  ├─ text adapter ───── messages, slash commands                      │
 Discord text   ◀──────▶ │  ├─ mixer ──────────── music · ambience · sfx → limiter → Opus       │
                         │  ├─ library ────────── SQLite, scanner, analyser, tag store          │
                         │  ├─ engine ─────────── triggers · scenes · game hooks · selection    │
                         │  ├─ event bus ──────── typed events (zod)                            │
                         │  └─ api server ─────── REST + WebSocket on 127.0.0.1:4242            │
                         │          ▲  PCM 16 kHz mono, per user           ▲                    │
                         │          ▼  transcripts (partial/final)          │ WS                │
                         │  EARS (Python) ── Vosk (keywords) + Whisper     DASHBOARD (React)    │
                         │  ws://127.0.0.1:4243                            served by core       │
                         │                                                                      │
                         │  Music folder(s) (read-only)      data/ (SQLite, logs, models)       │
                         └──────────────────────────────────────────────────────────────────────┘
```

### 4.1 Processes

| Process | Language | Responsibility | Crash behaviour |
|---|---|---|---|
| `core` | Node 22 / TS | Discord, mixer, library, engine, API, serves dashboard, supervises `ears` | Process manager restarts it; bot rejoins voice automatically (§14) |
| `ears` | Python 3.12 | Speech-to-text, keyword spotting | `core` restarts it with backoff; system degrades to Manual + text triggers and shows a warning |
| `dashboard` | React (static build) | UI | Stateless; reconnects WebSocket automatically |

In development, `npm run dev` starts all three with live reload. In production, `npm start` builds the dashboard and runs `core`, which launches `ears`.

### 4.2 Internal event bus

All modules communicate through a typed in-process event bus. Every event is defined once in `packages/shared` with a **zod** schema and forwarded to the dashboard over WebSocket. Minimum event set:

| Event | Payload (summary) |
|---|---|
| `voice.connection` | state: `disconnected` · `connecting` · `ready` · `reconnecting`, channel |
| `voice.speaking` | userId, speaking: boolean |
| `voice.level` | userId, rms (throttled to 10 Hz, for blips) |
| `transcript.partial` / `transcript.final` | userId, text, confidence, words[] (memory only, never persisted) |
| `trigger.matched` | triggerId, userId, subject, phrase, confidence, latencyMs |
| `trigger.suppressed` | triggerId, reason: `cooldown` · `negation` · `low_confidence` · `muted_user` · `state` |
| `scene.scored` | scores per scene (throttled to 1 Hz) |
| `scene.suggested` | sceneId, confidence, reasons[] |
| `scene.changed` | from, to, cause: `manual` · `auto` · `accepted_suggestion` · `hook` |
| `track.started` / `track.ended` | layer, trackId, reason |
| `sfx.fired` | sfxId, userId?, triggerId? |
| `mixer.state` | layer gains, ducking, master level (10 Hz) |
| `game.focus` / `game.despair` / `game.roll` | game hook payloads (§9.6) |
| `library.scan` | progress, added, changed, removed, errors |
| `system.health` | per-component status: `ok` · `degraded` · `down`, message |
| `listening.state` | global on/off, per-user exclusions |

### 4.3 Repository layout

```
cantina/
├─ CLAUDE.md                 # working rules for Claude Code (from Appendix A)
├─ README.md                 # human quick start
├─ .env.example              # all env vars, documented
├─ docs/
│  ├─ SPEC.md                # this file
│  ├─ DECISIONS.md           # ADR-style log of decisions and deviations
│  ├─ PROGRESS.md            # phase checklist, kept current by Claude Code
│  ├─ HUMAN-TASKS.md         # things Ant must do, generated from §19
│  ├─ SETUP-DISCORD.md       # step-by-step bot creation and invite (§19.2)
│  └─ style/
│     ├─ reference.mov       # Ant's reference video (add manually)
│     └─ frames/             # stills extracted from it for quick reference
├─ apps/
│  ├─ core/                  # Node/TS: discord, mixer, library, engine, api
│  │  └─ src/{adapters,mixer,library,engine,api,bus,config,util}/
│  └─ dashboard/             # React + Vite
│     └─ src/{scope,panels,routes,state,styles,fonts}/
├─ ears/                     # Python sidecar
│  ├─ pyproject.toml         # managed with uv
│  └─ ears/{server.py,vosk_engine.py,whisper_engine.py,vad.py,protocol.py}
├─ packages/
│  └─ shared/                # zod schemas, event types, API types
├─ config/
│  ├─ settings.yaml          # committed, no secrets
│  ├─ scenes.yaml            # committed
│  ├─ triggers.yaml          # committed
│  ├─ hooks.mtfbwy.yaml      # committed
│  ├─ players.example.yaml   # committed
│  └─ players.yaml           # GITIGNORED (Discord user IDs)
├─ data/                     # GITIGNORED: cantina.db, models/, logs/, backups/
├─ scripts/                  # doctor, setup, service install, fixture generation
└─ tests/
   └─ fixtures/audio/        # generated with macOS `say` (§16.3)
```

npm workspaces for `apps/*` and `packages/*`. Python managed separately with `uv`.

---

## 5. Discord integration

### 5.1 Bot application

Created by Ant in the Discord Developer Portal (step-by-step in §19.2).

- **Gateway intents:** `Guilds`, `GuildVoiceStates`, `GuildMessages`, `MessageContent` (privileged; needed only for text-chat triggers; toggle on in the portal).
- **OAuth2 scopes:** `bot`, `applications.commands`.
- **Bot permissions:** View Channels, Send Messages, Embed Links, Read Message History, Connect, Speak, Use Voice Activity. Optional: Priority Speaker, Change Nickname (for the "listening" nickname indicator).
- Single guild. Slash commands are registered **per guild** (instant updates) via `npm run commands:register`.

### 5.2 Getting the bot into the voice channel

Three ways, all MUST work:

1. **Slash command:** `/join` joins the voice channel the caller is in. `/leave` leaves.
2. **Dashboard:** a "Join" control listing the guild's voice channels, with the current occupants.
3. **Auto-join (default on):** when the configured GM user (`settings.yaml: discord.gmUserId`) joins any voice channel in the guild, the bot follows within 3 s. When the channel empties of humans, the bot fades out and leaves after 60 s.

### 5.3 Slash commands

| Command | Who | Effect |
|---|---|---|
| `/join`, `/leave` | GM role | Join the caller's channel / leave |
| `/scene <name>` | GM role | Switch scene (autocomplete from `scenes.yaml`) |
| `/play <query>` | GM role | Play a specific track now (autocomplete from the library) |
| `/sfx <name>` | Everyone (configurable) | Fire an SFX (autocomplete; players see their own personal SFX first) |
| `/stop [layer]` | GM role | Fade out one layer or all |
| `/volume <layer> <0-100>` | GM role | Set layer volume |
| `/mode <manual\|suggest\|auto>` | GM role | Automation mode |
| `/lock`, `/unlock` | GM role | Freeze the current scene; auto changes become suggestions only |
| `/listen on\|off` | GM role | Global speech recognition toggle |
| `/listen me on\|off` | Everyone | Opt yourself in or out of speech recognition |
| `/panic` | GM role | Fade everything to silence over 1 s and switch to Manual |
| `/status` | Everyone | Ephemeral: scene, track, mode, listening state |

"GM role" is configurable: a Discord role ID and/or a list of user IDs in `settings.yaml`.

### 5.4 Text channel behaviour

- The bot posts in a configured text channel (`discord.announceChannelId`) when it joins voice and when listening is switched on: *"🎙 Cantina is listening for cues. Audio is processed locally and never stored. Use `/listen me off` to opt out."*
- While listening, the bot's nickname gets a suffix (e.g. `Cantina · listening`) if it has permission.
- Text triggers: messages in configured channels run through the same trigger engine (§9) as speech, with the author as speaker.
- Dice bot parsing (§9.6) reads results from a configured dice bot's messages.

---

## 6. Audio engine (mixer)

### 6.1 Format

- Internal format: **48 kHz, stereo, 32-bit float** frames of **20 ms** (960 samples per channel), converted to signed 16-bit PCM and Opus-encoded for Discord (`StreamType.Raw` into one long-lived `AudioResource`).
- Decoding: one FFmpeg child process per playing source, outputting `f32le` at 48 kHz stereo, with `-ss` seeking support.
- The mixer runs on a steady 20 ms clock with a small jitter buffer (3 frames). It MUST NOT block on disk I/O; sources pre-buffer at least 500 ms.

### 6.2 Layers

| Layer | Concurrency | Behaviour |
|---|---|---|
| **Music** | 1 active + 1 fading | Continuous. When a track ends, the next is chosen from the current scene's pool (§10). Crossfades on change. |
| **Ambience** | Up to 3 beds | Looping environmental beds (rain, engine hum, cantina crowd). Gapless looping with loop points or a short crossfade to the file's own start. |
| **SFX** | Up to 8 voices | One-shots and stateful loops (e.g. a saber hum). Oldest or quietest voice is stolen when full. |

### 6.3 Gain staging

- Each file has a stored **loudness offset** from analysis (§8.3) so everything plays at a consistent perceived level. Targets: music **−18 LUFS**, ambience **−24 LUFS**, SFX peak-normalised to **−3 dBFS** then scaled by its layer.
- Per-layer gain (0–100 in the UI, mapped to dB with a sensible curve), master gain, per-item gain trim.
- **Ducking:** when any non-excluded user is speaking, the music layer dips by `ducking.depthDb` (default **−6 dB**, attack 150 ms, release 800 ms). SFX MAY duck music briefly (−4 dB for the SFX's duration). Both configurable and toggleable from the dashboard.
- **Limiter** on the master bus (lookahead ~5 ms, ceiling −1 dBFS). Nothing should ever clip.

### 6.4 Transitions

- **Crossfade:** equal-power, length per scene (e.g. combat 1.5 s, calm 6 s); default 3 s.
- **Stings:** short cues for events (triumph, doom, reveal). Music ducks by 10 dB under the sting, then restores. A sting MAY instead end the current music and start the next scene.
- **Panic:** everything fades to silence in 1 s.
- **Intro skip:** tracks MAY have an `intro_skip_s` so long quiet intros don't kill momentum.

### 6.5 Output adapters

- **Discord voice:** primary.
- **Local speakers:** plays the same mix through the Mac's default output via an FFmpeg or `naudiodon`/CoreAudio sink. Used for in-person sessions and for testing without Discord.
- **Browser cue (preview):** the dashboard can preview any track or SFX in the browser (Ant's headphones only, never sent to Discord), via a range-request audio endpoint.

---

## 7. Listening pipeline ("ears")

### 7.1 Input adapters

| Adapter | Speaker identity | Notes |
|---|---|---|
| **Discord voice** | Per Discord user, exact | Primary. Per-user Opus decoded to PCM in core. |
| **Discord text** | Message author | No speech recognition needed; goes straight to the engine. |
| **Local microphone** | None (single stream) | For in-person sessions. Triggers rely on character names in the phrase (§9.3). |
| **Simulator** | Chosen in UI/CLI | Typed lines or audio fixtures, attributed to any player. For development and testing. |

### 7.2 Flow

1. Core subscribes to each speaking user's Opus stream (`receiver.subscribe(userId, { end: AfterSilence 800 ms })`).
2. Core decodes Opus to 48 kHz stereo PCM, downmixes to mono, resamples to **16 kHz s16le**, and sends binary frames to `ears` over `ws://127.0.0.1:4243`, each frame tagged with `userId` and a sequence number.
3. Users who have opted out (`/listen me off`) or are muted in Cantina are **never sent to ears**. Their audio is still used for the speaking indicator (on/off only).
4. `ears` runs two engines in parallel per user stream:
   - **Keyword engine (Vosk):** a restricted grammar built from every trigger phrase, character name and scene keyword. Emits partial results within ~200–400 ms. Used for **SFX triggers**, where speed matters.
   - **Transcript engine (Whisper):** runs on VAD-segmented utterances (Silero VAD), returns a final transcript. Used for **scene scoring** and the live transcript panel, where accuracy and context matter.
5. Results return to core as JSON: `{ type: "partial"|"final", engine: "vosk"|"whisper", userId, text, confidence, words: [{ w, start, end, conf }] }`.
6. Core passes them to the engine (§9, §10) and to the dashboard transcript panel.

### 7.3 Engines and models

| Engine | Default model | Notes |
|---|---|---|
| Vosk | `vosk-model-small-en-us-0.15` (~40 MB) | Grammar mode. Test with UK accents early; offer the larger English model as a setting. |
| Whisper (Apple Silicon) | `mlx-whisper` or `whisper.cpp` with Metal, model `small.en` | Fast on M-series. Configurable up to `medium.en`. |
| Whisper (Intel fallback) | `whisper.cpp` CPU, `base.en` | Slower; the transcript panel may lag. |
| VAD | Silero VAD | Segments utterances; drops silence and noise. |

Models are downloaded on first run into `data/models/` by `npm run setup` (a one-time network fetch; listed in §11.3).

- **Custom vocabulary:** Whisper gets an `initial_prompt` built from character names, place names and Star Wars terms (`lightsaber`, `blaster`, `hyperspace`, `Despair`, `Focus`, etc.) from `config/vocabulary.yaml`. Vosk gets them in its grammar.
- **Latency budget for SFX:** phrase end → partial match ≤ 400 ms; match → sound starting in the mix ≤ 100 ms; Discord delivery ~100–300 ms. Target total **≤ 1.0 s**, acceptable **≤ 1.5 s**. Measure and show it in the event log.

### 7.4 Privacy rules for ears (MUST)

- Audio buffers are held in memory only and discarded after processing. No audio is ever written to disk.
- Transcripts live in a rolling in-memory buffer (default **5 minutes**, configurable down to 0, meaning "process and drop"). They are never persisted, never logged, and never sent anywhere except the local dashboard.
- Logs record **decisions**, not speech: `trigger saber-ignite matched for james (conf 0.82, 640 ms)`, not what was said around it.
- A **debug capture** mode MAY exist for tuning, but it MUST be off by default, show a persistent red banner in the dashboard while on, auto-disable after 15 minutes, and write only to `data/debug/` (gitignored), which is wiped on next start.

---

## 8. Library and tagging

### 8.1 Sources

- One or more **library roots** configured in `.env` (`CANTINA_LIBRARY_PATHS`, colon-separated), e.g. `~/Music/Cantina/Soundtracks:~/Music/Cantina/SFX`.
- Roots are **read-only** to Cantina. It MUST NOT modify, move, rename or retag the original files. All tags live in the database.
- A watcher (`chokidar`) picks up added, changed, moved and removed files. Moved files are matched by content hash so tags survive reorganisation.
- External drives: if a root is missing at start, show a clear warning and run with what's available.

### 8.2 Scan

For each file: path, size, mtime, **content hash** (xxhash of the first and last 1 MB plus size, for speed), duration, sample rate, channels, and existing metadata via `music-metadata` (title, artist, album, album artist, track number, year, genre, embedded comments). Also capture **folder names**, since album folders are a strong signal.

Initial `kind` guess:
- In a folder or with a name suggesting SFX (`sfx`, `sound effects`, `foley`, short duration under ~20 s) → `sfx`.
- Long, loop-like, low-dynamics files or names containing `ambience`, `ambient`, `atmos`, `loop`, `bed`, `room tone` → `ambience`.
- Everything else → `music`.

### 8.3 Audio analysis (local)

Run in the background, resumable, with progress in the dashboard:

- **Integrated loudness (LUFS)** and true peak via FFmpeg `ebur128` → stored gain offset (§6.3).
- **Energy curve** (RMS over time, 1 s windows) → `energy` 0–1 and a mini waveform for the UI.
- **Tempo** estimate and **onset density** (via `librosa` in the ears environment, run as a batch job).
- **Silence detection** at start and end → suggested `intro_skip_s` and trim.
- **Loopability heuristic** for ambience: similarity of the last and first seconds.
- **Vocals likelihood** (simple spectral heuristic, or an optional small classifier) → flags tracks with singing or lyrics, which are excluded from auto selection by default because they clash with speech.

### 8.4 Enrichment (inferring tags)

Ant's files have names and sit in albums, so most of the tagging can be inferred and then reviewed. The pipeline is a set of **providers**, each proposing tags with a confidence and a source. Nothing is ever applied silently as "confirmed".

| Provider | Network? | What it does | Default |
|---|---|---|---|
| **Heuristics** | No | Filenames, folders, durations, analysis features → kind, loopable, intensity guess | On |
| **AcoustID + MusicBrainz** | Yes (opt-in) | Fingerprints files with `fpcalc` (Chromaprint), looks up recording, album and track title. Sends a fingerprint, not audio. Needs a free AcoustID API key. | Off until Ant enables it |
| **Claude Code tagging pass** | Via Claude Code | `npm run tags:export` writes `data/tagging/batch-NNN.json` (path, title, album, duration, analysis features, current tags). Claude Code researches the soundtrack cues (it can search the web), writes proposals to `batch-NNN.proposals.json`, then `npm run tags:import` loads them as *inferred*. | Primary method for the first pass |
| **Local LLM (Ollama)** | No | Same job as the Claude pass, using a local model, for ongoing new files. | Optional |
| **Ant** | No | Reviews, edits, confirms in the dashboard. | Always wins |

Proposal format (shared by the Claude pass and Ollama):

```json
{
  "trackId": "trk_8f2c",
  "proposed": {
    "kind": "music",
    "scenes": ["combat", "chase"],
    "moods": ["heroic", "urgent"],
    "intensity": 4,
    "settings": ["space"],
    "factions": ["rebels"],
    "vocals": "none",
    "loopable": false,
    "diegetic": false
  },
  "confidence": 0.78,
  "rationale": "Cue title and album position suggest a starfighter battle; high onset density and energy.",
  "sources": ["title", "album", "analysis", "web: soundtrack cue listing"]
}
```

### 8.5 Provenance and learning

Every tag on a track carries:
- `source`: `heuristic` · `musicbrainz` · `claude` · `ollama` · `user`
- `confidence`: 0–1
- `status`: `inferred` · `confirmed` · `rejected`

Rules:
- A `user` action always wins and is never overwritten by a provider.
- Rejected tags are remembered so providers don't propose them again.
- **Implicit feedback:** a track the GM skips within 15 s in a scene gets a small negative weight for that scene; a track the GM plays manually into a scene gets a small positive weight; thumbs up/down in the dashboard give stronger weights. Weights affect selection (§10.3), never the tags themselves.

### 8.6 Taxonomy (initial; editable in `config/taxonomy.yaml`)

| Facet | Values |
|---|---|
| `kind` | music, ambience, sfx, sting |
| `scenes` | calm, exploration, travel, hyperspace, cantina, social, mystery, stealth, tension, chase, combat, boss, dark-side, force, sorrow, triumph, horror, montage |
| `moods` | heroic, ominous, melancholy, playful, mysterious, triumphant, tense, serene, urgent, eerie, romantic, grim |
| `intensity` | 1 (still) → 5 (all-out) |
| `settings` | space, ship-interior, desert, jungle, ice, swamp, city, underworld, temple, ruins, forest, ocean |
| `factions` | empire, rebels, jedi, sith, smugglers, bounty-hunters, locals, droids |
| `vocals` | none, choir, lyrics |
| `diegetic` | true (in-world, like a cantina band) / false (score) |
| `loopable` | true / false |
| SFX `category` | saber, blaster, weapon, explosion, impact, door, ship, engine, droid, creature, crowd, computer, force, magic, footsteps, nature, ui |
| SFX `phase` | ignite, hum, swing, clash, retract, fire, reload, open, close, start, stop, loop, one-shot |

### 8.7 Data model (SQLite)

```
tracks(id, path, root, hash, size, mtime, title, artist, album, album_artist,
       track_no, year, duration_s, sample_rate, channels, kind,
       lufs, true_peak, gain_db, energy, tempo_bpm, onset_density,
       intro_skip_s, loop_start_s, loop_end_s, vocals, diegetic, loopable,
       intensity, rating, play_count, last_played_at, missing, notes,
       created_at, updated_at)
track_tags(track_id, facet, value, source, confidence, status, updated_at)
track_scene_weights(track_id, scene_id, weight)          -- implicit feedback
waveforms(track_id, peaks BLOB)
players(id, discord_user_id, display_name, character_name, aliases JSON)
sfx_overrides(player_id, trigger_id, track_id)            -- mirrors players.yaml
events(id, ts, type, payload JSON)                        -- event log, no speech
settings(key, value JSON)
schema_migrations(version, applied_at)
```

Migrations are versioned and run at start. `npm run library:export` writes all tags, weights and overrides to `data/backups/library-YYYYMMDD.yaml`; `library:import` restores. A backup is written automatically before every migration and at the end of every session.

---

## 9. Trigger engine (sound effects and cues)

### 9.1 Concepts

- A **trigger** maps phrases (and/or events) to an action: fire an SFX, start or stop a loop, play a sting, nudge a scene, or change game state.
- A **subject** is whose effect it is: the speaker, or a character named in the phrase.
- **State** lets triggers be stateful (a saber that's on can be switched off; a hum loop runs while it's on).

### 9.2 Matching

1. **Normalise:** lower case, strip punctuation, expand contractions, number words to digits, and apply a synonym map (`saber` = `sabre` = `lightsaber` = `light saber`).
2. **Pattern match** against compiled phrase patterns. Patterns support alternatives `(his|her|their)`, optional words `[my]`, and slots `{character}`, `{player}`, `{number}`.
3. **Fuzzy tolerance:** token-level Levenshtein plus Double Metaphone phonetic matching to survive recognition errors ("lights abre", "ignite mile light saber"). Per-trigger `fuzziness` (default 0.2).
4. **Confidence** = recogniser confidence × match score. Fire if ≥ `minConfidence` (default 0.6).
5. **Negation guard:** suppress if a negator (`don't`, `not`, `never`, `won't`, `can't`, `stop`, "if I") appears within 3 tokens before the verb. Also suppress questions about the action ("should I ignite my lightsaber?") when `ignoreQuestions: true` (default).
6. **Cooldowns:** per trigger (default 4 s) and per subject. A Vosk partial and the later Whisper final for the same utterance MUST NOT double-fire; dedupe by utterance ID.
7. **Speaker filters:** `speakers: [james]`, `exceptSpeakers`, and the global opt-out list.

### 9.3 Subject resolution (who is igniting what)

In order:
1. If the phrase contains a character name or player alias (from `players.yaml`), that character is the subject. This handles the GM narrating: *"Kael ignites his lightsaber"* plays Kael's saber even though Ant said it.
2. Otherwise, if the phrase is first person ("I", "my"), the **speaker** is the subject.
3. Otherwise, use the trigger's `defaultSubject` (usually `none`, which falls back to the generic sound).

### 9.4 Sound resolution

1. A per-player override in `players.yaml` for this trigger, if the subject has one.
2. Otherwise the trigger's `sound` (a specific file or a tag query, e.g. `{ category: saber, phase: ignite }`), picking at random among matches with a no-repeat memory of the last 3.

### 9.5 Config format (`config/triggers.yaml`)

```yaml
triggers:
  - id: saber-ignite
    phrases:
      - "[i] (ignite|activate|draw|light) [up] my (lightsaber|saber)"
      - "{character} (ignites|activates|draws) (his|her|their) (lightsaber|saber)"
    subject: auto                     # auto = §9.3
    sound: { category: saber, phase: ignite }
    setsState: { "{subject}.saber": on }
    loop:                              # starts after the one-shot
      sound: { category: saber, phase: hum }
      layer: sfx
      gainDb: -14
      while: "{subject}.saber == on"
      maxSeconds: 120                  # safety stop
    cooldownS: 4
    minConfidence: 0.6

  - id: saber-retract
    phrases:
      - "[i] (deactivate|retract|extinguish|sheathe|turn off) my (lightsaber|saber)"
      - "{character} (deactivates|retracts|sheathes) (his|her|their) (lightsaber|saber)"
    requiresState: { "{subject}.saber": on }
    sound: { category: saber, phase: retract }
    setsState: { "{subject}.saber": off }

  - id: blaster-fire
    phrases: ["[i] (fire|shoot) [my|the] blaster", "{character} (fires|shoots)"]
    sound: { category: blaster, phase: fire }
    cooldownS: 1.5
    alsoNudgeScene: { combat: 2 }      # contributes to scene scoring (§10.2)

  - id: hyperspace-jump
    phrases: ["(punch it|jump to hyperspace|make the jump|engage (the )?hyperdrive)"]
    sound: { category: ship, phase: start, tags: [hyperspace] }
    alsoNudgeScene: { hyperspace: 6 }
```

`config/players.yaml` (gitignored):

```yaml
players:
  - id: james
    discordUserId: "000000000000000000"   # [HUMAN] fill in
    displayName: James
    character: Kael Voss                  # example
    aliases: [Kael, Voss]
    sfx:
      saber-ignite: "Sabers/Kael - Crossguard Ignite.wav"   # relative to a library root
      saber-retract: "Sabers/Kael - Crossguard Retract.wav"
      saber-ignite.loop: "Sabers/Kael - Crossguard Hum.wav"
  - id: ant
    discordUserId: "000000000000000000"
    displayName: Ant
    role: gm
```

The dashboard MUST provide a UI for editing triggers and player mappings (§12.8) that writes back to these YAML files, preserving comments where possible (use the `yaml` package's document API).

### 9.6 Game hooks (MTFBWY preset, `config/hooks.mtfbwy.yaml`)

Ant runs his own TTRPG, MTFBWY. Use its terminology exactly: the **Focus** (never "spotlight"), **Despair**, **Balance**, **Dyad dice** (2d12: a Balance die and a Despair die).

Inputs for hooks:
- **Speech/text phrases:** "the GM takes the Focus", "I spend [n] Despair", "roll initiative" is NOT an MTFBWY term (there is no initiative), so don't rely on it; use "combat begins" / "weapons out" / "ambush" style cues instead.
- **Dashboard controls:** a Despair pool counter (+/−), a "GM has the Focus" toggle, and quick buttons for roll outcomes.
- **Dice bot messages** (optional, §20 Q9): parse results posted in Discord by a configured dice bot.

Default hook behaviours:

| Event | Effect |
|---|---|
| Despair pool rises | Raises scene **tension** (shifts music selection up one intensity step per 2 Despair spent in the last 5 minutes, capped) |
| GM spends 3 Despair to interrupt a Hero | Ominous sting |
| Major crit (double 12) | Triumphant sting |
| Major crit fail (double 1) | Doom sting |
| Minor crit (doubles 2–11) | Short positive sting (rate-limited) |
| GM takes the Focus during combat | Optional: brief ambience swell or "enemy turn" motif |
| Scene concluded / full rest | Shift towards `calm` |

Hooks are a generic plugin interface (`engine/hooks/`), with MTFBWY as the first preset, so other systems can be added later.

---

## 10. Scene engine (music direction)

### 10.1 Scenes (`config/scenes.yaml`)

```yaml
scenes:
  - id: calm
    label: Calm
    music: { scenes: [calm], intensity: [1, 2], vocals: [none] }
    ambience: { auto: true }          # pick beds matching current setting
    crossfadeS: 6
    minDwellS: 120
    priority: 10
    entry:
      keywords: { "we rest": 4, "take a break": 3, "camp": 2, "full rest": 5, "short rest": 3 }

  - id: tension
    label: Tension
    music: { scenes: [tension, stealth, mystery], intensity: [2, 3] }
    crossfadeS: 4
    minDwellS: 90
    priority: 40
    entry:
      keywords: { "something's wrong": 3, "we hear": 2, "footsteps": 2, "sneak": 2, "trap": 3, "quiet": 1 }

  - id: combat
    label: Combat
    music: { scenes: [combat], intensity: [3, 5], vocals: [none] }
    crossfadeS: 1.5
    minDwellS: 90
    priority: 80
    entry:
      keywords: { "ambush": 5, "attack": 2, "open fire": 4, "weapons out": 4, "blaster": 1, "draw my": 1 }
      events: [trigger.blaster-fire, trigger.saber-ignite]
    exit:
      keywords: { "they're all down": 5, "the fight is over": 5, "we won": 3 }
      fallback: tension

  - id: boss
    label: Boss
    music: { scenes: [boss, dark-side], intensity: [4, 5] }
    crossfadeS: 1
    minDwellS: 180
    priority: 90
    manualOnly: true                    # never chosen automatically
```

Every scene MUST be selectable manually. `manualOnly` scenes are never auto-selected.

### 10.2 Scoring

- Every keyword hit, trigger nudge and hook adds weighted points to scenes, with **exponential decay** (half-life 30 s by default).
- Points from the GM's speech MAY be weighted higher (`gmWeight: 1.5`), since the GM narrates.
- A scene becomes a **candidate** when its score exceeds `threshold` (default 6) **and** beats the current scene's score by `hysteresis` (default 3) **and** the current scene has been active for at least its `minDwellS`, unless the candidate has `priority` ≥ 80 and a score of ≥ 2× threshold (combat can always break in).
- **Optional (MAY, off by default):** a local LLM classifier (Ollama) reads the last 60 s of transcript every 20 s and returns scene probabilities, which are added as another weighted signal.

### 10.3 Modes

| Mode | Behaviour |
|---|---|
| **Manual** | Scores are shown, nothing changes on its own. |
| **Suggest** (default) | A candidate appears as a callout on the scope with Accept / Dismiss, and a keyboard shortcut. It expires after 20 s. Accept and dismiss are logged as feedback. |
| **Auto** | Candidates are applied automatically. The GM can undo with one click within 10 s ("Revert to previous scene"). |
| **Lock** (modifier) | Freezes the current scene in any mode; candidates only appear as suggestions. |

### 10.4 Track selection

Given the active scene's music query:

1. Filter: matching tags (inferred or confirmed, excluding rejected), not missing, `vocals` allowed, intensity within range (shifted by tension from hooks).
2. Score each track: `base 1.0 × confidence × (1 + scene weight) × rating factor × recency penalty`. Recency penalty: heavily down-weight anything played in the last 45 minutes; never repeat the previous 5 tracks.
3. Weighted random pick.
4. If no track matches: relax intensity, then moods, then fall back to the scene's `fallback` scene, then to any `calm` music. Log a library gap ("No confirmed combat tracks at intensity 5") for the dashboard's library health view.

---

## 11. Privacy, consent and security

### 11.1 Principles (MUST)

1. **Local processing only.** Speech recognition, trigger matching, scene scoring and tagging inference all run on the Mac.
2. **No persistence of speech.** No audio or transcripts on disk (§7.4).
3. **No telemetry, analytics or crash reporting** to any third party.
4. **Dashboard binds to `127.0.0.1` by default.** LAN access is opt-in, protected by a PIN, and shows a banner while enabled (§12.10).
5. **Secrets** live in `.env` only, which is gitignored. `.env.example` documents every variable without values.
6. **Fonts and assets bundled locally.** The dashboard makes no external requests at runtime.

### 11.2 Consent

- Everyone at the table should know the bot listens. The join announcement (§5.4), nickname indicator and `/listen me off` make this explicit.
- Per-user opt-out is respected at the source: opted-out audio is never sent to ears.
- Ant should check Discord's current Developer Terms and Developer Policy on processing voice data before using this with anyone outside his own group. **[HUMAN]**

### 11.3 Complete list of network destinations

Cantina MUST make no network requests other than:

| Destination | When |
|---|---|
| Discord gateway, REST API and voice servers | Always, while running |
| Model downloads (Vosk, Whisper, Silero) | Once, during `npm run setup` |
| npm / PyPI | Installing dependencies |
| AcoustID + MusicBrainz APIs | Only if Ant enables the provider, only during tagging |
| `127.0.0.1:11434` (Ollama) | Only if enabled; local |

A unit test SHOULD assert that no unexpected hosts are contacted (stub `fetch`/`undici` and fail on unknown hosts).

### 11.4 IP and content

- The repo contains no audio and no third-party artwork.
- The UI uses an original identity (§12.2). No Lucasfilm logos, wordmarks or real in-universe company names.
- Ant's audio files are his own; Cantina is for private use with his group.

---

## 12. Dashboard and visual design

### 12.1 Design intent

The console should feel like a diagnostic terminal on a starship maintenance bay: black glass, glowing white wireframe linework, a single hot signal-red for whatever is active or needs attention, tiny technical readouts in the corners, and a faint CRT shimmer. Calm when nothing is happening; alive when the table is.

**Reference:** `docs/style/reference.mov` (Ant to add; see §19.1). Key traits observed in it:

- A wide, **elongated hexagonal frame**: chamfered left and right ends, a **notch at the top centre** with a tick scale and a small red diamond marker.
- A **central circle** (thin red stroke) with faint **diagonal perspective lines** running from the frame's corners towards the centre.
- **Concentric horizontal ellipses** (orbit rings) in red behind the subject, with small chevron markers.
- The subject rendered as **white wireframe line art with a soft glow**; the selected part fills **solid red**.
- **Corner brackets** (lock-on marks) around the selected element, and a **leader-line callout** with a small numbered label ("07 · SIDE PANEL").
- A **row of small white tick blocks** along the bottom inner edge (reads like a level meter), and fine tick scales on the left and right edges.
- **Microtext** in the corners: tiny red status lines (top right), a manufacturer wordmark with a small subtitle (top left), and a bottom status strip with a short red progress bar.
- CRT feel: deep black with slight vignette, bloom on bright lines, very subtle noise.

### 12.2 Identity

- App wordmark: **CANTINA** with subtitle **AMBIENT ACOUSTICS CONSOLE**.
- Faux manufacturer line (replaces the reference's real Star Wars mark): **VANTARI ACOUSTIC SYSTEMS · MODEL AC-7** (invented; rename freely).
- A simple original glyph: a circle cut by three horizontal lines of decreasing width (an abstract speaker or orbit), drawn in the same line style.

### 12.3 Design tokens

```css
:root {
  /* surfaces */
  --bg:            #050506;
  --bg-vignette:   #000000;
  --panel:         #0b0b0d;
  --panel-raised:  #111114;

  /* linework */
  --line:          #ededed;
  --line-dim:      #6b6b70;
  --line-faint:    #2a2a2e;
  --line-glow:     rgba(255, 255, 255, 0.35);

  /* signal */
  --signal:        #ff3b1f;   /* active, selected, alerts */
  --signal-dim:    #8c1f10;
  --signal-faint:  #3a0d07;
  --signal-glow:   rgba(255, 59, 31, 0.45);

  /* status (always paired with a label or shape, never colour alone) */
  --warn:          #ffb020;
  --ok:            #ededed;   /* "ok" is quiet white, not green */

  /* type */
  --font-display:  "Oxanium", system-ui, sans-serif;     /* labels, headings */
  --font-mono:     "JetBrains Mono", ui-monospace, monospace; /* readouts, microtext */

  /* geometry */
  --stroke:        1px;
  --stroke-bold:   1.5px;
  --chamfer:       28px;
  --gap:           12px;
}
```

- Fonts are open-licence and self-hosted via `@fontsource` (no CDN).
- Labels are uppercase with letter-spacing 0.08–0.14em; body and transcript text are sentence case for readability.
- Contrast: `--signal` on `--bg` is roughly 5.7:1 and `--line` on `--bg` well above 15:1, so both pass WCAG AA for normal text. `--line-dim` is for decoration and secondary labels only (AA for large text). Any text conveying information MUST be at least 12 px and AA.

### 12.4 Layout (desktop, 1440 × 900 primary; MUST remain usable at 1024 × 768)

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ◎ CANTINA  AMBIENT ACOUSTICS CONSOLE      DISCORD ▪ VOICE ▪ EARS ▪ LIBRARY       │
│   VANTARI ACOUSTIC SYSTEMS               [MANUAL|SUGGEST|AUTO] [LOCK] ●LISTENING  │
├───────────────┬──────────────────────────────────────────────┬───────────────────┤
│ SCENES        │                THE SCOPE                     │ TRANSCRIPT        │
│ 1 CALM        │   ╱‾‾‾‾‾‾‾‾‾‾‾‾‾╲__▽__╱‾‾‾‾‾‾‾‾‾‾‾‾‾‾╲       │ ANT  the door...  │
│ 2 TENSION  ◀  │  ╱   blips    ( scene + track )   blips   ╲      │ JAMES I ignite my │
│ 3 COMBAT      │  ╲   orbit rings, callouts, brackets      ╱      │   [LIGHTSABER]    │
│ ...           │   ╲▁▁▁▁▁▁▁▁ ▮ ▮ ▮ level meter ▮ ▮ ▮ ▁▁▁▁╱       │                   │
│ LAYERS        │                                              │ EVENT LOG         │
│ MUSIC   ▮▮▮▯  │  NOW: "Track title" · Album · 02:14 / 04:51   │ 12:41 SFX saber…  │
│ AMBIENCE▮▮▯▯  │  NEXT: ...                     DESPAIR ◆◆◆◇◇  │ 12:40 SCENE →…    │
│ SFX     ▮▮▮▮  │                                              │                   │
├───────────────┴──────────────────────────────────────────────┴───────────────────┤
│ SOUNDBOARD  [ALL] [ANT] [JAMES] [...]   ▢ ignite  ▢ retract  ▢ blaster  ▢ door …  │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Routes: **Console** (above, default) · **Library** · **Triggers** · **Players** · **Scenes** · **Settings** · **Simulator** (dev mode, or toggle in settings).

### 12.5 The Scope (centrepiece)

Built as an SVG frame (crisp, resolution-independent) with a Canvas 2D layer inside for the animated content.

| Element | Meaning |
|---|---|
| Hexagonal frame + top notch | Container. The notch's tick scale is the **tension gauge**; the red diamond marker moves with tension (driven by Despair and scene intensity). |
| Central circle | Current **scene** name (large, uppercase) and current track title (small). Turns solid-red outline briefly on scene change. |
| Orbit rings (3 ellipses) | Inner = SFX, middle = ambience, outer = music. Ring brightness follows each layer's level; chevrons travel round the rings at a speed proportional to intensity. |
| Player blips | One per person in voice, placed around the outer ring with name labels. Glow white when speaking; flash red when they trigger something; hollow when opted out of listening. |
| Callouts | When a trigger fires: corner brackets around the player's blip and a leader line to a label like `07 · SABER IGNITE · KAEL`. Fades after 6 s. Numbered sequentially per session. |
| Suggestion callout | In Suggest mode: a red bracketed callout `SUGGEST · COMBAT · 82%` with `[ACCEPT ⏎]` `[DISMISS ESC]`, showing the top reasons on hover or focus. |
| Bottom tick row | Master **level meter** (spectrum bins), white blocks, red when the limiter is working. |
| Side tick scales | Layer gain readouts. |
| Corner microtext | Top right: tiny red status lines (latency, CPU, model, uptime). Bottom: status strip with a red progress bar for the current track. |
| Perspective lines | Decorative, faint. |

**MAY (stretch):** a rotating white wireframe 3D object in the centre circle (three.js `EdgesGeometry`, additive glow) whose sections fill red per active layer and which pulses with the music, directly echoing the reference video.

### 12.6 Motion and effects

- Rings rotate slowly (one revolution per ~40 s at intensity 1, faster with intensity). Blips ease in and out (150 ms). Callouts draw their leader line over 200 ms.
- CRT layer: subtle scanlines (2 px period, ~4% opacity), vignette, gentle bloom on bright lines (Canvas `shadowBlur` or a second blurred pass), very faint flicker (opacity ±1.5%, irregular). All CRT effects are toggleable in Settings.
- `prefers-reduced-motion`: no rotation, no flicker, no animated draws; state changes are instant.
- Render at up to 60 fps only when the tab is visible; throttle to 4 fps when hidden.

### 12.7 Panels

- **Scenes:** big buttons, numbered 1–9 for shortcuts, current scene marked with a red bar and the word ACTIVE (not just colour). Shows the live score as a thin bar on each.
- **Layers:** a fader, mute and level meter per layer plus master; ducking toggle and depth.
- **Now playing / queue:** current track per layer with progress, "Next" with skip and pin, "Play now", "Queue next", "Crossfade to", thumbs up/down.
- **Transcript:** live, colour plus name per speaker, trigger words highlighted with a red underline and bracket; partials in dim, finals in full. Header shows retention ("Memory only · 5 min") and a clear button.
- **Event log:** scene changes, SFX, suggestions accepted or dismissed, errors, with latency for triggers.
- **Soundboard:** grid of SFX buttons, filterable by player tab and category; personal SFX labelled with the character name. Click to fire, right-click (or long-press) to preview in browser.
- **Game:** Despair pool counter, Focus toggle, roll outcome buttons (§9.6).
- **Health:** small status lamps for Discord, Voice, Ears, Library, each with a label (`OK`, `DEGRADED`, `DOWN`) and a tooltip explaining what's wrong and what to do.

### 12.8 Library, Triggers, Players and Scenes screens

- **Library:** virtualised table (thousands of rows) with columns for title, album, kind, scenes, moods, intensity, status, confidence. Filters by facet, status (`inferred`/`confirmed`), and "needs review". Inline tag editing; bulk select and "confirm all inferred" for a filter; mini waveform; preview play; per-row rationale from the provider. A **Library health** view lists gaps (e.g. "only 2 confirmed combat tracks").
- **Triggers:** list and edit triggers; phrase editor with a live test box ("type a phrase and see which triggers match, with scores"); sound picker; cooldown and confidence controls.
- **Players:** map Discord users currently in the guild to player profiles (character name, aliases); per-player SFX overrides with drag-and-drop from the library.
- **Scenes:** edit scenes, music queries (with a live count of matching tracks), keywords and weights.

### 12.9 Keyboard shortcuts

| Key | Action |
|---|---|
| `1`–`9` | Switch to scene 1–9 |
| `Enter` / `Esc` | Accept / dismiss suggestion |
| `Space` | Pause/resume music layer |
| `N` | Next track |
| `L` | Toggle lock |
| `M` | Cycle mode |
| `Shift+P` | Panic |
| `/` | Focus search (library, soundboard) |
| `Q`…`P`, `A`…`;` | Soundboard slots (configurable) |

All interactive elements MUST be keyboard reachable with a visible focus ring (red, 2 px, offset).

### 12.10 LAN / iPad mode (SHOULD)

Off by default. When on, the core also binds to the Mac's LAN address, requires a 6-digit PIN (shown on the Mac's dashboard), sets a session cookie, and shows a persistent banner on both screens. Layout adapts to iPad landscape (1180 × 820) with larger touch targets (min 44 px).

---

## 13. API

REST under `/api`, WebSocket at `/ws`. All request and response bodies are validated with the zod schemas in `packages/shared`. This API also enables future Stream Deck or MIDI control.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/state` | Full snapshot (voice, scene, layers, mode, players, health) |
| POST | `/api/voice/join` `{ channelId }` / `/api/voice/leave` | Voice control |
| POST | `/api/scene` `{ sceneId }` | Change scene |
| POST | `/api/suggestion/:id/accept` · `/dismiss` | Suggestions |
| POST | `/api/mode` `{ mode }` · `/api/lock` `{ locked }` | Automation |
| POST | `/api/layers/:layer` `{ gain?, muted? }` | Mixer |
| POST | `/api/music/play` `{ trackId, transition? }` · `/next` · `/queue` | Music |
| POST | `/api/sfx/fire` `{ sfxId | triggerId, subject? }` | SFX |
| POST | `/api/panic` | Panic |
| GET | `/api/library?filters…` · PATCH `/api/library/:id` | Library browse and edit |
| POST | `/api/library/scan` · `/api/library/analyse` | Jobs |
| GET | `/api/media/:trackId` | Range-request audio for browser preview |
| GET/PUT | `/api/config/:name` | Read and write scenes, triggers, players, settings |
| POST | `/api/sim/say` `{ playerId, text }` · `/api/sim/audio` | Simulator |
| POST | `/api/game/despair` `{ delta }` · `/focus` · `/roll` | Game hooks |

---

## 14. Robustness

| Failure | Required behaviour |
|---|---|
| Voice connection drops | Reconnect with exponential backoff (1, 2, 4, 8 … max 30 s); resume the current scene and music position; show `RECONNECTING` |
| DAVE / `4017` close | Show a specific error naming DAVE and the library versions; `npm run doctor` explains how to fix |
| Ears crashes or stalls (no heartbeat for 5 s) | Restart with backoff; meanwhile Manual mode + text triggers; health lamp `DEGRADED` |
| FFmpeg decode error / missing file | Skip to the next track; mark the file `missing` or `bad`; surface in Library health |
| Library root unavailable | Warn; continue with available roots; recheck every 60 s |
| Discord rate limit | Queue and retry; never crash |
| Token invalid | Clear startup error pointing to §19.2 |
| Config YAML invalid | Refuse to apply the change; keep running on the previous config; show the validation error with line numbers |
| Core crash | Process manager restarts it; on start, rejoin the last channel if the GM is still in it |
| Mac about to sleep | `caffeinate` while a session is active (§15.4) |
| Long sessions | No memory growth over 4 hours (soak test in P7) |

Graceful shutdown (SIGINT/SIGTERM): fade out over 1 s, leave voice, flush the event log, write a library backup.

---

## 15. Setup and running

### 15.1 Prerequisites (installed by `scripts/setup-mac.sh`, which Ant runs once)

- Homebrew
- Node.js **22.12+** (via `fnm` or Homebrew `node@22`)
- Python **3.12** and **uv**
- FFmpeg
- Chromaprint (`fpcalc`), only needed if AcoustID is enabled
- Optional: Ollama

### 15.2 Commands

| Command | Does |
|---|---|
| `npm run setup` | Installs Node and Python deps, downloads models, creates `.env` from the example, creates `data/` |
| `npm run doctor` | Checks everything: Node version, FFmpeg, Python env, models present, DAVE library loads, `.env` complete, token valid, guild reachable, library roots readable, mic permission (if enabled). Prints a green/red checklist with fixes. |
| `npm run commands:register` | Registers slash commands in the guild |
| `npm run dev` | Core + ears + dashboard with live reload; opens `http://127.0.0.1:4242` |
| `npm start` | Production build and run |
| `npm run library:scan` / `library:analyse` | Library jobs |
| `npm run tags:export` / `tags:import` | Tagging pass (§8.4) |
| `npm run library:export` / `library:import` | Backup and restore of tags |
| `npm run sim -- --as james --say "I ignite my lightsaber"` | Inject a line through the engine |
| `npm run fixtures` | Generate audio fixtures with macOS `say` |
| `npm test` · `npm run test:e2e` · `npm run lint` · `npm run typecheck` | Quality gates |
| `npm run service:install` / `service:uninstall` | Install as a launchd user agent so it runs in the background |

### 15.3 Environment variables (`.env.example`)

```
DISCORD_TOKEN=                # [HUMAN] from the Developer Portal
DISCORD_CLIENT_ID=            # [HUMAN] Application ID
DISCORD_GUILD_ID=             # [HUMAN] your server's ID
CANTINA_LIBRARY_PATHS=        # [HUMAN] e.g. /Users/ant/Music/Cantina/Soundtracks:/Users/ant/Music/Cantina/SFX
CANTINA_PORT=4242
CANTINA_EARS_PORT=4243
CANTINA_LAN=false
ACOUSTID_API_KEY=             # optional
OLLAMA_URL=                   # optional, e.g. http://127.0.0.1:11434
```

Non-secret settings (GM user ID, announce channel, ducking, thresholds, retention) live in `config/settings.yaml`.

### 15.4 Session mode

When the bot joins voice, core spawns `caffeinate -dimsu -w <pid>` so the Mac stays awake for exactly as long as the session runs.

### 15.5 Updating

`git pull && npm run setup && npm start`. Migrations run automatically, with a backup first.

---

## 16. Testing strategy

### 16.1 Unit (Vitest, pytest)

- Mixer: frame timing, equal-power crossfade sums, ducking envelope, limiter never exceeds ceiling, voice stealing.
- Trigger matcher: phrase patterns, fuzzy and phonetic tolerance, negation, questions, cooldowns, dedupe of partial/final, subject resolution (speaker vs named character), state transitions, per-player sound resolution.
- Scene scorer: decay, hysteresis, dwell, priority break-in, manual-only, lock.
- Selection: filters, recency, fallbacks, library gap logging.
- Config: YAML schema validation with helpful errors; comment-preserving writes.
- Library: hash-based move detection, kind heuristics, provenance precedence (user always wins).
- Network allowlist test (§11.3).

### 16.2 Integration

- **Simulator-driven scenarios** in `tests/scenarios/*.yaml`, e.g.:

```yaml
name: James ignites, GM narrates Kael retracting
players: [ant, james]
steps:
  - { as: james, say: "Right, I ignite my lightsaber" }
  - expect: { sfx: "Sabers/Kael - Crossguard Ignite.wav", within_ms: 300 }
  - { as: ant, say: "Kael deactivates his saber and steps back" }
  - expect: { sfx: "Sabers/Kael - Crossguard Retract.wav" }
  - { as: james, say: "I don't ignite my lightsaber yet" }
  - expect: { no_sfx: true }
```

- **Ears with audio fixtures:** fixtures are generated with macOS `say` in several voices and speeds (`say -v Daniel -r 180 -o ignite.aiff "I ignite my lightsaber"`), converted to 16 kHz WAV, and fed through ears. Assert recognition and trigger results.
- **Mixer output:** render 10 s of a scenario to a WAV in a temp dir, assert no clipping and correct layer presence. (Test artefacts only; never real session audio.)

### 16.3 End-to-end

- Playwright (Chromium) smoke tests for the dashboard: loads, WebSocket connects, scene change via UI reflects in state, suggestion accept works, keyboard shortcuts work, axe accessibility scan has no serious violations.

### 16.4 Manual test plan (Ant, in Discord)

A checklist in `docs/MANUAL-TESTS.md`, run at the end of P1, P4, P5, P6 and P7: join/leave, auto-join, play, crossfade, SFX over music, per-player saber with two real people, opt-out, reconnection (toggle Wi-Fi), 30-minute soak.

---

## 17. Working agreement for Claude Code

1. **Read this spec fully first.** Then create `CLAUDE.md` from Appendix A, `docs/PROGRESS.md` from §18, and `docs/HUMAN-TASKS.md` from §19.
2. **Work phase by phase, in order.** Each phase on a branch `phase/<n>-<slug>`, merged to `main` when its acceptance criteria pass. Commit in small, meaningful steps with clear messages.
3. **Keep the quality gates green:** `npm run lint`, `npm run typecheck`, `npm test` (and `pytest` for ears) before every merge. Add tests with every feature.
4. **Defaults over questions.** For anything not settled, use the default in §20, record it in `docs/DECISIONS.md` (date, decision, reason, alternatives), and continue.
5. **Stop and ask only for [HUMAN] items** or when a decision is irreversible (e.g. deleting user data). Batch questions; never block on one if other work can continue.
6. **Never** commit secrets, `.env`, `config/players.yaml`, anything in `data/`, or any audio file. Never write audio or transcripts to disk outside tests.
7. **Never modify Ant's music files.** Library roots are read-only.
8. **Spikes first for risks.** Prove DAVE receive (P1) and recognition accuracy (P4) before building on them. If a spike fails, write up the findings and options in `DECISIONS.md` and pick the best fallback (§21).
9. **Develop without Discord where possible.** Use the simulator, local speakers adapter and fixtures. Note what can only be verified on Ant's Mac in Discord and add it to `docs/MANUAL-TESTS.md`.
10. **Keep `docs/PROGRESS.md` current** at the end of every working session: what's done, what's next, what's blocked.
11. **Respect the design.** Follow §12; when in doubt, look at `docs/style/frames/`. Use the `frontend-design` mindset: intentional, not template-y.
12. **British English** in UI copy and docs.

---

## 18. Phases and acceptance criteria

### P0: Foundations

- Monorepo scaffold per §4.3; TypeScript strict; ESLint + Prettier; Vitest; Python package with uv and pytest.
- `packages/shared` with event and API schemas (initial set).
- `scripts/setup-mac.sh`, `npm run setup`, `npm run doctor` (checks that apply so far).
- `.env.example`, `.gitignore` (covers `.env`, `data/`, `config/players.yaml`, audio extensions, `node_modules`, `.venv`).
- `CLAUDE.md`, `docs/PROGRESS.md`, `docs/HUMAN-TASKS.md`, `docs/SETUP-DISCORD.md`, `docs/DECISIONS.md`.
- Optional: GitHub Actions running lint, typecheck and tests on push.

**Done when:** a fresh clone on the Mac runs `npm run setup && npm run doctor && npm test` successfully (doctor may show Discord items as pending).

### P1: Voice out, mixer, and the DAVE spike

- Discord client login; `/join`, `/leave`, `/panic`, `/status`; slash command registration.
- Mixer with three layers, crossfades, ducking (stubbed input), limiter.
- Local speakers output adapter.
- Play a file from a library root by path into the music layer; fire an SFX over it.
- **Spike: DAVE receive.** Subscribe to each speaking user, decode to PCM in memory, compute RMS, emit `voice.level`. Show live levels in a temporary page. Do not save audio.
- Auto-join and auto-leave (§5.2).

**Done when:** in Ant's server, the bot joins on `/join` and when Ant joins voice; music plays with an SFX layered on top without interruption; crossfade between two tracks sounds clean; each speaker's level appears live; reconnection works after toggling Wi-Fi.

### P2: Console v1 (the Kenku replacement)

- Dashboard app with the visual system (§12.3), console layout, The Scope (frame, rings, centre, bottom meter, corner microtext), scenes panel, layers panel, now playing/queue, soundboard, health lamps, keyboard shortcuts.
- Scenes from `scenes.yaml` with **temporary manual track assignment** (a scene can list explicit files) until the library exists.
- WebSocket live state; REST actions.

**Done when:** Ant can run a session entirely by hand from the browser: switch scenes, change volumes, fire SFX, skip tracks; the scope reacts to layer levels; reduced-motion and CRT toggles work; Playwright smoke test and axe scan pass.

### P3: Library and tagging

- Scanner, watcher, hash-based identity, metadata, kind heuristics.
- Analysis jobs (loudness, energy, silence, tempo, loopability, vocals likelihood); gain offsets applied in the mixer.
- SQLite schema and migrations; backup/export/import.
- Enrichment providers: heuristics; Claude Code tagging pass (`tags:export`/`tags:import`); AcoustID/MusicBrainz (behind a setting); Ollama (optional).
- Library screen with review workflow; Library health view.
- Scenes switch from manual lists to tag queries (§10.4).

**Done when:** Ant's full library is scanned and analysed; Claude Code has completed a first tagging pass over every file with rationale; Ant can review and confirm in bulk; scenes draw music by tags; loudness is consistent across tracks.

### P4: Ears

- Python ears service: WebSocket protocol, Vosk grammar engine, Whisper transcript engine, Silero VAD, heartbeat.
- Core: per-user audio routing to ears, opt-outs, `/listen` commands, join announcement, nickname indicator.
- Transcript panel (memory only), speaking blips on the scope.
- Local microphone input adapter.
- Simulator (UI panel and CLI); audio fixtures via `say`.
- Custom vocabulary (`config/vocabulary.yaml`).

**Done when:** live, speaker-labelled transcripts appear for each person in voice; opted-out users are never transcribed; keyword partials arrive within ~400 ms of phrase end on fixtures; ears can be killed and recovers automatically with the UI showing `DEGRADED` meanwhile.

### P5: Triggers

- Trigger engine per §9: patterns, fuzzy/phonetic, negation, questions, cooldowns, dedupe, subject resolution, per-player overrides, state and loops.
- Text-channel triggers.
- Triggers and Players screens with the live phrase tester.
- Callouts on the scope; latency in the event log.

**Done when:** the scenario tests in §16.2 pass; in a real Discord test with two people, James's personal saber fires on "I ignite my lightsaber" within 1.5 s in at least 9 of 10 tries; "I don't ignite my lightsaber" does not fire; the GM narrating "Kael ignites his saber" fires Kael's saber.

### P6: Scenes and game hooks

- Scene scorer (§10.2), modes and lock (§10.3), suggestion callouts, undo in Auto.
- Selection with feedback weights (§8.5, §10.4).
- Stings.
- MTFBWY hooks (§9.6) with Game panel; dice bot parsing if configured.
- Optional Ollama scene classifier behind a setting.

**Done when:** in a test session in Suggest mode, sensible suggestions appear for calm → tension → combat → calm without spurious flip-flopping; accept/dismiss is logged; a double 12 plays a triumphant sting; spending Despair visibly raises tension and shifts music intensity.

### P7: Hardening and polish

- launchd service install; `caffeinate` session mode; graceful shutdown.
- Robustness table (§14) fully implemented and tested where possible.
- 4-hour soak test (simulated input) with no memory growth or audio drift.
- LAN/iPad mode with PIN.
- README for humans; screenshots; `MANUAL-TESTS.md` complete.

**Done when:** a real 3-hour session runs without intervention; all checks in §1.3 are met or have a recorded plan.

### Stretch (after v1, in rough priority order)

1. Three.js wireframe centrepiece (§12.5).
2. Stream Deck / MIDI controller support via the API.
3. Local LLM scene classifier on by default once proven.
4. Speaker diarisation for local-mic mode (identify voices at an in-person table).
5. Per-player mini soundboards players can open on their phones.
6. Import Kenku FM playlists and soundboards.
7. Spotify as a *remote control* only (switching playlists on Ant's own device), never rebroadcasting.
8. Session "director's notes": an event-only timeline export (no speech).

---

## 19. Human tasks [HUMAN]

### 19.1 Before the build starts

1. **Create a private GitHub repo** called `cantina` (or your chosen name). Add this file as `docs/SPEC.md` and the reference video as `docs/style/reference.mov`. Commit and push.
2. **Clone it on the Mac** (e.g. into `~/Code/cantina`) and run Claude Code in that folder, so it can run and test against your real files. (Claude Code running in the cloud can write the code, but only the Mac can test Discord voice and your library.)
3. **Choose a library location**, e.g. `~/Music/Cantina/`, with `Soundtracks/` and `SFX/` inside. Copy or symlink your files there. Name personal SFX clearly, e.g. `SFX/Sabers/Kael - Crossguard Ignite.wav`.
4. **Answer what you can in §20.** Anything unanswered uses the default.

### 19.2 Create the Discord bot and get it into your server

1. Go to the Discord Developer Portal → **Applications** → **New Application**. Name it "Cantina".
2. **General Information:** copy the **Application ID** → `DISCORD_CLIENT_ID` in `.env`.
3. **Bot** tab: click **Reset Token**, copy it → `DISCORD_TOKEN`. Never share it or commit it. Under **Privileged Gateway Intents**, switch on **Message Content Intent** (only needed for text-chat triggers). Optionally switch off **Public Bot** so only you can invite it.
4. **OAuth2 → URL Generator:** tick scopes `bot` and `applications.commands`. Under bot permissions tick View Channels, Send Messages, Embed Links, Read Message History, Connect, Speak, Use Voice Activity (optionally Change Nickname). Copy the generated URL.
5. Open that URL in your browser, choose your server, and authorise. (You need "Manage Server" on that server.)
6. In Discord, **User Settings → Advanced → Developer Mode** on. Right-click your server → **Copy Server ID** → `DISCORD_GUILD_ID`. Right-click yourself → **Copy User ID** → `discord.gmUserId` in `config/settings.yaml`. Do the same for each player → `config/players.yaml`.
7. Right-click the text channel for announcements → **Copy Channel ID** → `discord.announceChannelId`.
8. Run `npm run commands:register`, then `npm run dev`. Join a voice channel: the bot should follow you in (or type `/join`).

### 19.3 During and after the build

- Approve tagging proposals in the Library screen.
- Run the manual test checklist at the end of P1, P4, P5, P6, P7 with at least one other person.
- Tell your players the bot listens, and how to opt out.
- Check Discord's Developer Terms/Policy on voice data (§11.2).

---

## 20. Open questions (with defaults)

Answer any of these by editing this table or telling Claude Code. Unanswered = default.

| # | Question | Why it matters | Default if unanswered |
|---|---|---|---|
| Q1 | What should the app be called? | Repo, bot name, wordmark | **Cantina** |
| Q2 | Is the Mac Apple Silicon (M-series) or Intel? How much RAM? | Speech model choice and speed | **Apple Silicon, 16 GB+**; `small.en` Whisper |
| Q3 | Where will the music and SFX live, roughly how many files and GB, and is any of it on an external drive? | Scan time, watcher, missing-root handling | `~/Music/Cantina`, internal disk |
| Q4 | How many players usually, and do they use headphones? | Echo of bot audio into mics can cause false triggers | 3–5 players; assume **mixed** headphone use, so add a short "self-hear" guard (ignore triggers for 300 ms after an SFX with speech-like content) |
| Q5 | Do players use push-to-talk or voice activity? | Utterance segmentation | Either; handled by VAD |
| Q6 | Are you (the GM) in the same voice channel, running the dashboard on the same Mac? | Layout and auto-join | Yes, same Mac; second monitor if available |
| Q7 | Should the dashboard be reachable from an iPad or phone? | LAN mode | **Off**; available as a setting (§12.10) |
| Q8 | Which character names, places and terms should speech recognition know? | Accuracy on Star Wars and MTFBWY vocabulary | Seed `vocabulary.yaml` with common Star Wars terms and MTFBWY terms; Ant adds characters |
| Q9 | How do you roll dice: physical, a Discord dice bot (which?), or a VTT? | Game hooks | **Dashboard buttons**; text parsing off until a bot is named |
| Q10 | Can players fire their own SFX with `/sfx`? Can they see others'? | Permissions | **Yes, own and generic SFX only** |
| Q11 | Allow tracks with lyrics in auto selection? | Lyrics clash with speech | **No** (manual play still allowed) |
| Q12 | Default automation mode? | Trust | **Suggest** |
| Q13 | Ducking under speech on by default? How deep? | Clarity vs atmosphere | **On, −6 dB** |
| Q14 | Transcript retention in memory? | Privacy vs usefulness | **5 minutes**, never on disk |
| Q15 | Tagging approach for the first pass? | Effort and privacy | **Claude Code pass** + heuristics; AcoustID off; Ollama off |
| Q16 | Bot auto-joins when you join voice? | Convenience | **Yes**, for the GM only |
| Q17 | Which text channel for announcements? Text triggers in which channels? | Noise | Announcements in one channel; text triggers in the same channel only |
| Q18 | Should the bot ever speak or post beyond announcements? | Noise | **No** |
| Q19 | Other game systems besides MTFBWY? | Hooks design | MTFBWY preset + generic |
| Q20 | Kenku FM: replace it, or run alongside? | Scope | **Replace**; Kenku import is a stretch goal |
| Q21 | Which personal SFX per player to start with? | P5 testing | Saber ignite/hum/retract for James's character; add others later |
| Q22 | Wording of the consent announcement? | Group norms | As in §5.4 |
| Q23 | Do you want a "director's cut" event timeline after each session (no speech)? | Reflection | **Off** (stretch) |
| Q24 | Should the bot leave when you leave, even if players remain? | Behaviour | **No**; leaves when no humans remain |
| Q25 | Preferred keyboard layout for soundboard slots? | Shortcuts | QWERTY rows as in §12.9 |

---

## 21. Risks and fallbacks

| Risk | Likelihood | Impact | Mitigation / fallback |
|---|---|---|---|
| DAVE receive doesn't work or breaks with a Discord update | Medium | High | Spike in P1. Fallbacks in order: (a) update to the latest `@discordjs/voice`/`@snazzah/davey`; (b) try another library with DAVE receive (e.g. a Python stack) behind the same adapter interface; (c) use a **Stage channel** for sessions (not E2EE); (d) run triggers from text chat + local-mic adapter + manual. The rest of Cantina works regardless. |
| Recognition misses Star Wars words or UK accents | Medium | Medium | Custom vocabulary, Vosk grammar, fuzzy/phonetic matching, larger models, per-user tuning; Suggest mode by default |
| False triggers from casual talk | Medium | Medium | Negation and question guards, confidence thresholds, cooldowns, phrase specificity, per-trigger disable, opt-out |
| Bot audio picked up by players' mics | Medium | Low | Discord echo cancellation, headphones advice, self-hear guard (Q4), no lyrics in auto |
| Latency too high for SFX | Low | Medium | Vosk partials, pre-decoded SFX buffers in RAM, short mixer buffer |
| Tagging quality poor | Medium | Medium | Provenance, review UI, implicit feedback, Library health gaps |
| Mac sleeps or Wi-Fi blips mid-session | Medium | Medium | `caffeinate`, reconnection, resume position |
| Scope rendering heavy on CPU | Low | Low | Throttle, reduced effects toggle, Canvas over DOM |

---

## Appendix A: `CLAUDE.md` (create in repo root during P0)

```markdown
# CLAUDE.md: working rules for Cantina

Source of truth: docs/SPEC.md. Read it before any work. Progress: docs/PROGRESS.md.

## Rules
- Work phase by phase (SPEC §18). Branch per phase: phase/<n>-<slug>. Merge when acceptance criteria pass.
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
```

## Appendix B: Kick-off prompt for Claude Code

> Read `docs/SPEC.md` in full. Then, following §17, create `CLAUDE.md` from Appendix A, `docs/PROGRESS.md` from §18, `docs/HUMAN-TASKS.md` from §19, and `docs/DECISIONS.md`. Extract a few still frames from `docs/style/reference.mov` into `docs/style/frames/` with FFmpeg. Start Phase 0 and continue through the phases in order, using the defaults in §20 for anything unanswered. Stop only for [HUMAN] items, and batch those questions. Keep `docs/PROGRESS.md` current as you go.

## Appendix C: Glossary

| Term | Meaning |
|---|---|
| **DAVE** | Discord's end-to-end encryption protocol for voice and video, mandatory since March 2026 |
| **Ears** | The local Python speech recognition sidecar |
| **Layer** | One of the mixer's three buses: music, ambience, SFX |
| **Scene** | A musical state (calm, tension, combat…) defined by a tag query and entry/exit cues |
| **Trigger** | A rule mapping phrases or events to an action, usually an SFX |
| **Subject** | Whose effect a trigger plays: the speaker or a named character |
| **Sting** | A short musical cue for a dramatic event |
| **Suggest mode** | The engine proposes scene changes; the GM accepts or dismisses |
| **Provenance** | Where a tag came from, how confident it is, and whether it's confirmed |
| **Focus / Despair / Balance / Dyad dice** | MTFBWY terms: who the story is focused on; the GM's tension currency; the good-outcome die; the 2d12 roll |

## Appendix D: References

- Discord: [Every voice and video call is now E2EE](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted)
- Discord developer docs: [Voice connections and DAVE](https://docs.discord.com/developers/topics/voice-connections)
- [`@discordjs/voice` documentation](https://discord.js.org/docs/packages/voice/main) (Node 22.12+, `@snazzah/davey`, receive caveat)
- [discord.js guide: voice](https://discordjs.guide/voice)
- Vosk, Whisper (`whisper.cpp`, `mlx-whisper`), Silero VAD, Chromaprint/AcoustID, MusicBrainz, `music-metadata`, `better-sqlite3`, FFmpeg `ebur128`
