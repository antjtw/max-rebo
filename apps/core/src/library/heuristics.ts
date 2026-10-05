import type { Kind } from '@cantina/shared';

/**
 * Heuristic enrichment provider (SPEC §8.2, §8.4): filenames, folders, durations → kind and
 * initial tags. Everything it proposes is `inferred` with modest confidence, for review.
 */

export const AUDIO_EXTENSIONS = new Set([
  '.wav',
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.m4a',
  '.aac',
  '.aif',
  '.aiff',
  '.opus',
  '.wma',
]);

export function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const SFX_FOLDER = /(^|[\s/_-])(sfx|sound ?effects?|foley|fx)([\s/_-]|$)/i;
const AMBIENCE_WORDS =
  /(ambien(ce|t)|atmos(phere)?|\bloop\b|\bbed\b|room ?tone|background|soundscape|drone)/i;
const STING_WORDS = /(\bsting(er)?\b|\bfanfare\b|\bstab\b|\bhit\b|\bshort cue\b)/i;

export interface KindGuess {
  kind: Kind;
  confidence: number;
  reason: string;
}

export function guessKind(relPath: string, durationS: number | null | undefined): KindGuess {
  const p = relPath.replace(/\\/g, '/');
  if (SFX_FOLDER.test(p)) return { kind: 'sfx', confidence: 0.8, reason: 'SFX folder or name' };
  if (AMBIENCE_WORDS.test(p))
    return { kind: 'ambience', confidence: 0.7, reason: 'ambience word in name' };
  if (STING_WORDS.test(p) && (durationS ?? 0) < 30)
    return { kind: 'sting', confidence: 0.6, reason: 'sting word, short' };
  if (durationS != null && durationS > 0 && durationS < 20)
    return { kind: 'sfx', confidence: 0.55, reason: 'shorter than 20 s' };
  return { kind: 'music', confidence: 0.5, reason: 'default' };
}

/** Keyword tables: a word in the title/album/folder → (facet, value). */
const SFX_CATEGORY: Record<string, string[]> = {
  saber: ['saber', 'sabre', 'lightsaber', 'lightsabre'],
  blaster: ['blaster', 'laser', 'pew'],
  weapon: ['gun', 'rifle', 'pistol', 'sword', 'weapon'],
  explosion: ['explosion', 'explode', 'boom', 'detonat', 'grenade', 'bomb'],
  impact: ['impact', 'hit', 'punch', 'thud'],
  door: ['door', 'hatch', 'airlock', 'gate'],
  ship: ['ship', 'starship', 'hyperspace', 'hyperdrive', 'flyby', 'fighter', 'spaceship'],
  engine: ['engine', 'thruster', 'speeder', 'motor'],
  droid: ['droid', 'robot', 'beep', 'astromech'],
  creature: ['creature', 'roar', 'growl', 'monster', 'beast'],
  crowd: ['crowd', 'cheer', 'murmur', 'chatter', 'walla'],
  computer: ['computer', 'console', 'terminal', 'alarm', 'klaxon', 'beeps'],
  force: ['force', 'push', 'choke'],
  magic: ['magic', 'spell'],
  footsteps: ['footstep', 'footsteps', 'steps', 'walk'],
  nature: ['rain', 'wind', 'thunder', 'water', 'birds', 'forest', 'jungle', 'storm'],
  ui: ['ui', 'click', 'notification', 'blip'],
};

const SFX_PHASE: Record<string, string[]> = {
  ignite: ['ignite', 'ignition', 'activate', 'activation', 'draw'],
  hum: ['hum', 'idle'],
  swing: ['swing', 'swoosh', 'whoosh'],
  clash: ['clash', 'block'],
  retract: ['retract', 'deactivate', 'sheathe', 'extinguish'],
  fire: ['fire', 'shot', 'shoot', 'blast'],
  reload: ['reload'],
  open: ['open', 'opening'],
  close: ['close', 'closing', 'shut'],
  start: ['start', 'startup', 'jump', 'takeoff'],
  stop: ['stop', 'shutdown', 'land'],
  loop: ['loop', 'looped'],
};

const SCENE_WORDS: Record<string, string[]> = {
  combat: [
    'battle',
    'fight',
    'combat',
    'attack',
    'duel',
    'war',
    'assault',
    'skirmish',
    'ambush',
    'clash',
  ],
  chase: ['chase', 'pursuit', 'escape', 'run', 'race'],
  boss: ['boss', 'showdown', 'final', 'confrontation'],
  calm: ['calm', 'peace', 'rest', 'serene', 'quiet', 'lullaby', 'dawn', 'sunrise'],
  exploration: ['exploration', 'explore', 'journey', 'wander', 'arrival', 'discovery'],
  travel: ['travel', 'journey', 'voyage', 'flight', 'departure'],
  hyperspace: ['hyperspace', 'lightspeed', 'hyperdrive'],
  cantina: ['cantina', 'tavern', 'bar', 'band', 'jazz'],
  social: ['tavern', 'market', 'festival', 'dance', 'party'],
  mystery: ['mystery', 'mysterious', 'secret', 'enigma', 'riddle'],
  stealth: ['stealth', 'sneak', 'infiltration', 'infiltrate'],
  tension: ['tension', 'suspense', 'danger', 'threat', 'dread', 'trap'],
  'dark-side': ['dark', 'sith', 'emperor', 'evil', 'sinister', 'menace'],
  force: ['force', 'jedi', 'meditation'],
  sorrow: ['sorrow', 'sad', 'death', 'funeral', 'lament', 'loss', 'farewell', 'requiem', 'tears'],
  triumph: ['triumph', 'victory', 'throne', 'celebration', 'heroes', 'finale'],
  horror: ['horror', 'nightmare', 'terror', 'scream'],
  montage: ['montage', 'training'],
};

const MOOD_WORDS: Record<string, string[]> = {
  heroic: ['hero', 'heroes', 'heroic', 'brave', 'rebel'],
  ominous: ['ominous', 'menace', 'doom', 'dark', 'imperial'],
  melancholy: ['melancholy', 'sad', 'lament', 'farewell', 'loss'],
  playful: ['playful', 'comic', 'fun', 'silly'],
  mysterious: ['mystery', 'mysterious', 'secret'],
  triumphant: ['triumph', 'victory', 'celebration'],
  tense: ['tense', 'tension', 'suspense'],
  serene: ['serene', 'peace', 'calm'],
  urgent: ['urgent', 'escape', 'chase', 'hurry'],
  eerie: ['eerie', 'ghost', 'haunted', 'strange'],
  romantic: ['love', 'romance', 'romantic'],
  grim: ['grim', 'death', 'war'],
};

const SETTING_WORDS: Record<string, string[]> = {
  space: ['space', 'star', 'stars', 'orbit', 'galaxy', 'nebula', 'asteroid'],
  'ship-interior': ['corridor', 'bridge', 'cockpit', 'hangar', 'engine room'],
  desert: ['desert', 'dune', 'dunes', 'sand', 'tatooine'],
  jungle: ['jungle'],
  ice: ['ice', 'snow', 'frozen', 'hoth'],
  swamp: ['swamp', 'bog', 'marsh'],
  city: ['city', 'street', 'streets', 'market'],
  underworld: ['underworld', 'smuggler', 'palace', 'slums'],
  temple: ['temple', 'shrine'],
  ruins: ['ruins', 'ruin', 'ancient'],
  forest: ['forest', 'woods'],
  ocean: ['ocean', 'sea', 'water'],
};

function match(table: Record<string, string[]>, toks: string[]): string[] {
  const out: string[] = [];
  const joined = ` ${toks.join(' ')} `;
  for (const [value, words] of Object.entries(table)) {
    if (
      words.some((w) =>
        w.includes(' ')
          ? joined.includes(` ${w} `)
          : toks.some((t) => t === w || (w.length >= 5 && t.startsWith(w))),
      )
    ) {
      out.push(value);
    }
  }
  return out;
}

export interface HeuristicTags {
  kind: KindGuess;
  scenes: string[];
  moods: string[];
  settings: string[];
  category: string[];
  phase: string[];
  tags: string[];
  intensity: number | null;
}

/** Everything the heuristic provider can say about a file from its names and duration. */
export function heuristicTags(input: {
  relPath: string;
  title: string;
  album?: string | null;
  genre?: string | null;
  durationS?: number | null;
  energy?: number | null;
  onsetDensity?: number | null;
}): HeuristicTags {
  const kind = guessKind(input.relPath, input.durationS);
  const toks = [
    ...tokens(input.relPath),
    ...tokens(input.title),
    ...tokens(input.album ?? ''),
    ...tokens(input.genre ?? ''),
  ];
  const isSfx = kind.kind === 'sfx';
  const scenes = isSfx ? [] : match(SCENE_WORDS, toks);
  const tags: string[] = [];
  if (toks.includes('hyperspace') || toks.includes('lightspeed')) tags.push('hyperspace');
  if (kind.kind === 'sting') {
    if (toks.some((t) => ['triumph', 'victory', 'fanfare'].includes(t)))
      tags.push('triumph', 'positive');
    if (toks.some((t) => ['doom', 'death', 'defeat', 'fail'].includes(t))) tags.push('doom');
    if (toks.some((t) => ['ominous', 'menace', 'threat', 'dark'].includes(t))) tags.push('ominous');
    if (toks.some((t) => ['reveal', 'discovery', 'surprise'].includes(t))) tags.push('reveal');
  }
  let intensity: number | null = null;
  if (input.energy != null) {
    const e = input.energy * 0.7 + Math.min(1, (input.onsetDensity ?? 0) / 6) * 0.3;
    intensity = Math.max(1, Math.min(5, Math.round(1 + e * 4)));
  } else if (scenes.some((s) => ['combat', 'chase', 'boss'].includes(s))) intensity = 4;
  else if (scenes.some((s) => ['calm', 'sorrow'].includes(s))) intensity = 1;
  return {
    kind,
    scenes,
    moods: isSfx ? [] : match(MOOD_WORDS, toks),
    settings: match(SETTING_WORDS, toks),
    category: isSfx ? match(SFX_CATEGORY, toks) : [],
    phase: isSfx ? match(SFX_PHASE, toks) : [],
    tags,
    intensity: isSfx ? null : intensity,
  };
}
