# Manual test plan (Ant, in Discord)

SPEC §16.4. Run at the end of P1, P4, P5, P6 and P7 with at least one other person. Everything here needs the Mac, Discord or real voices, so it can't be automated in the cloud.

Before each run: `npm run doctor` is green (or only shows items you've chosen to leave pending), then `npm run dev`.

## P1: voice out, mixer, DAVE

- [ ] `/join` from a voice channel: the bot joins within a few seconds. `/leave` leaves.
- [ ] Auto-join: leave voice, rejoin. The bot follows you in within 3 s.
- [ ] Auto-leave: everyone leaves. The bot fades out and leaves after about 60 s.
- [ ] Play a scene from the dashboard: music plays in Discord.
- [ ] Fire an SFX from the soundboard while music plays: the SFX plays over the music without interrupting it.
- [ ] Switch scenes twice: the crossfade sounds clean (no click, no level dip or bump).
- [ ] **DAVE receive spike:** speak, and have a friend speak. Each person's blip lights up on the Scope.
- [ ] Toggle Wi-Fi off for 10 s and back on: the Voice lamp shows RECONNECTING, then the bot is back and music resumes.
- [ ] `/panic`: everything fades out in about 1 s; mode switches to Manual.

## P4: ears

- [ ] Transcript panel shows speaker-labelled lines for each person within a second or two.
- [ ] `/listen me off` (friend): their lines stop appearing and their blip goes hollow. `/listen me on` restores it.
- [ ] `/listen all off`: no transcripts at all; nickname loses "· listening".
- [ ] Kill ears (`pkill -f "python -m ears"`): the Ears lamp goes DEGRADED, then OK again within ~10 s.
- [ ] Optional, on the Mac: `npm run fixtures`, then check recognition of the `say` fixtures.

## P5: triggers (James, two people)

- [ ] James says "I ignite my lightsaber" 10 times: his personal saber fires within 1.5 s at least 9 times (latency shows in the event log).
- [ ] "I don't ignite my lightsaber" does not fire.
- [ ] You narrate "Kael ignites his saber": Kael's saber fires. "Kael deactivates his saber": the hum stops.
- [ ] Casual chat for 10 minutes: no false triggers.
- [ ] Type "I fire my blaster" in the announce channel: the blaster fires (text triggers).

## P6: scenes and game hooks

- [ ] Suggest mode: play calm → tension ("we hear footsteps… something's wrong") → combat ("ambush!") → calm ("we take a full rest"). Sensible suggestions appear without flip-flopping.
- [ ] Accept and dismiss a few: both appear in the event log.
- [ ] Double 12 in the Game panel: triumphant sting.
- [ ] Spend 2 Despair twice: tension rises on the Scope's notch gauge and the next tracks are more intense.
- [ ] Auto mode: a change happens on its own; "Revert to previous scene" undoes it within 10 s.

## P7: hardening

- [ ] `npm run service:install`, log out and in: Cantina is running on http://127.0.0.1:4242.
- [ ] `kill -9` the core process while in voice: it restarts and rejoins your channel.
- [ ] 30-minute soak in a real session with Suggest on: no crash, no audio drift, CPU stays modest.
- [ ] LAN mode (optional): turn on in Settings, restart, open the console on the iPad, enter the PIN.
- [ ] Full 3-hour session with no intervention (SPEC §1.3).
