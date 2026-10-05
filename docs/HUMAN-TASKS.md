# Human tasks (things only Ant can do)

Generated from SPEC §19. Tick them off as you go.

## Before the build (§19.1)

- [x] Create a private GitHub repo (`antjtw/max-rebo`) and add the spec as `docs/SPEC.md`.
- [ ] Add the reference video as `docs/style/reference.mov`, then run `bash scripts/extract-frames.sh` to pull stills into `docs/style/frames/`.
- [ ] Clone the repo on the Mac (e.g. `~/Code/cantina`) and run Claude Code there for anything that needs Discord voice or the real library.
- [ ] Choose a library location, e.g. `~/Music/Cantina/` with `Soundtracks/` and `SFX/` inside. Name personal SFX clearly, e.g. `SFX/Sabers/Kael - Crossguard Ignite.wav`.
- [ ] Answer what you can in SPEC §20. Everything unanswered uses the default (recorded in `docs/DECISIONS.md`, D-003).

## Discord bot (§19.2)

- [ ] Follow `docs/SETUP-DISCORD.md` to create the application and bot, invite it, and fill in `.env`, `config/settings.yaml` and `config/players.yaml`.
- [ ] Run `npm run commands:register`, then `npm run dev`, and join a voice channel.

## During and after the build (§19.3)

- [ ] Approve tagging proposals in the Library screen (after P3's tagging pass).
- [ ] Run `docs/MANUAL-TESTS.md` at the end of P1, P4, P5, P6 and P7 with at least one other person.
- [ ] Tell your players the bot listens, and how to opt out (`/listen me off`).
- [ ] Check Discord's current Developer Terms and Developer Policy on processing voice data (§11.2).

## Questions currently blocking nothing

None of the work so far is blocked. These would sharpen things when you have a moment (SPEC §20):

1. Q2: Apple Silicon or Intel, and how much RAM? (Default: Apple Silicon, 16 GB+.)
2. Q3: Roughly how many files and GB, and any on an external drive?
3. Q8: Character names, places and terms for `config/vocabulary.yaml`.
4. Q9: Do you use a Discord dice bot? If so, which one, so its messages can be parsed.
5. Q21: James's character name and the file names of their saber SFX, for `config/players.yaml`.
