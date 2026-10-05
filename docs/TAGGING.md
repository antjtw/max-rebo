# Tagging pass (for Claude Code)

SPEC §8.4. Ant's files are mostly untagged soundtracks and SFX. Cantina proposes tags; Ant confirms them in the Library screen. This is the brief for the **Claude Code tagging pass**, the primary method for the first pass.

## Steps

1. On the Mac: `npm run library:scan && npm run library:analyse && npm run tags:export`.
2. This writes `data/tagging/batch-NNN.json` (40 tracks each): path, title, album, artist, track number, year, duration, analysis features, and current tags (inferred, confirmed, **rejected**).
3. For each batch, research the cues (album, track title, the film or game they come from, the scene they score; web search is fine for soundtrack cue listings) and write `data/tagging/batch-NNN.proposals.json` in the format below.
4. Run `npm run tags:import`. Proposals load as **inferred** with source `claude`, confidence and rationale. Imported files are renamed to `*.imported.json`.
5. Ant reviews in the Library screen (filter "Needs review", bulk confirm, reject the misses).

## Proposal format

A JSON array, one object per track:

```json
{
  "trackId": "trk_8f2c1a9b3d",
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

For SFX, use `category` and `phase` instead of scenes and moods, e.g. `{ "kind": "sfx", "category": ["saber"], "phase": ["ignite"] }`. For stings, use `"kind": "sting"` and `tags` such as `triumph`, `doom`, `ominous`, `positive`, `reveal`.

## Rules

- Use only values from `config/taxonomy.yaml`. Every field is optional; omit what you can't judge.
- **Never propose a value listed under `rejected`** for that track. Ant has said no.
- Values under `userConfirmed` are settled; don't contradict them.
- `intensity`: 1 still, 2 gentle, 3 moving, 4 driving, 5 all-out. The `energy` (0–1) and `onsetDensity` (onsets per second) features help.
- `vocals`: `lyrics` for any sung words (these are excluded from automatic selection), `choir` for wordless or chant-like choir, else `none`. A `vocalsScore` above ~0.6 hints at voice.
- `loopable` matters for ambience: steady beds without a clear start or end. `loopScore` above ~0.6 helps.
- `diegetic`: true for in-world music (a cantina band), false for score.
- `confidence`: 0.9+ only when the cue is identified with a source; 0.5–0.7 for educated guesses from titles and features.
- Keep `rationale` to one sentence about _why_, not a restatement of the tags.
