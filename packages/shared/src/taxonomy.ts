import { z } from 'zod';

/** Initial taxonomy (SPEC §8.6). `config/taxonomy.yaml` may extend these at runtime. */
export const KINDS = ['music', 'ambience', 'sfx', 'sting'] as const;
export const Kind = z.enum(KINDS);
export type Kind = z.infer<typeof Kind>;

export const LAYERS = ['music', 'ambience', 'sfx'] as const;
export const Layer = z.enum(LAYERS);
export type Layer = z.infer<typeof Layer>;

export const MODES = ['manual', 'suggest', 'auto'] as const;
export const Mode = z.enum(MODES);
export type Mode = z.infer<typeof Mode>;

export const VOCALS = ['none', 'choir', 'lyrics'] as const;
export const Vocals = z.enum(VOCALS);
export type Vocals = z.infer<typeof Vocals>;

export const TAG_SOURCES = ['heuristic', 'musicbrainz', 'claude', 'ollama', 'user'] as const;
export const TagSource = z.enum(TAG_SOURCES);
export type TagSource = z.infer<typeof TagSource>;

export const TAG_STATUSES = ['inferred', 'confirmed', 'rejected'] as const;
export const TagStatus = z.enum(TAG_STATUSES);
export type TagStatus = z.infer<typeof TagStatus>;

export const DEFAULT_TAXONOMY = {
  kind: [...KINDS],
  scenes: [
    'calm',
    'exploration',
    'travel',
    'hyperspace',
    'cantina',
    'social',
    'mystery',
    'stealth',
    'tension',
    'chase',
    'combat',
    'boss',
    'dark-side',
    'force',
    'sorrow',
    'triumph',
    'horror',
    'montage',
  ],
  moods: [
    'heroic',
    'ominous',
    'melancholy',
    'playful',
    'mysterious',
    'triumphant',
    'tense',
    'serene',
    'urgent',
    'eerie',
    'romantic',
    'grim',
  ],
  settings: [
    'space',
    'ship-interior',
    'desert',
    'jungle',
    'ice',
    'swamp',
    'city',
    'underworld',
    'temple',
    'ruins',
    'forest',
    'ocean',
  ],
  factions: ['empire', 'rebels', 'jedi', 'sith', 'smugglers', 'bounty-hunters', 'locals', 'droids'],
  vocals: [...VOCALS],
  category: [
    'saber',
    'blaster',
    'weapon',
    'explosion',
    'impact',
    'door',
    'ship',
    'engine',
    'droid',
    'creature',
    'crowd',
    'computer',
    'force',
    'magic',
    'footsteps',
    'nature',
    'ui',
  ],
  phase: [
    'ignite',
    'hum',
    'swing',
    'clash',
    'retract',
    'fire',
    'reload',
    'open',
    'close',
    'start',
    'stop',
    'loop',
    'one-shot',
  ],
} as const;

/** Multi-valued facets stored as rows in track_tags. */
export const TAG_FACETS = [
  'scenes',
  'moods',
  'settings',
  'factions',
  'category',
  'phase',
  'tags',
] as const;
export const TagFacet = z.enum(TAG_FACETS);
export type TagFacet = z.infer<typeof TagFacet>;

export const Taxonomy = z.record(z.string(), z.array(z.string()));
export type Taxonomy = z.infer<typeof Taxonomy>;
