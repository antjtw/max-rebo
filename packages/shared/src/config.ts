import { z } from 'zod';
import { Layer, Mode, Vocals } from './taxonomy.ts';

/* ------------------------------------------------------------------ */
/* settings.yaml (SPEC §15.3: non-secret settings)                     */
/* ------------------------------------------------------------------ */

const DiscordId = z.string().regex(/^\d{5,25}$/, 'must be a Discord snowflake (digits only)');
const OptionalDiscordId = z.union([DiscordId, z.literal('')]).default('');

export const SettingsSchema = z.object({
  discord: z
    .object({
      gmUserId: OptionalDiscordId,
      gmRoleId: OptionalDiscordId,
      gmUserIds: z.array(DiscordId).default([]),
      announceChannelId: OptionalDiscordId,
      textTriggerChannelIds: z.array(DiscordId).default([]),
      autoJoin: z.boolean().default(true),
      autoLeaveAfterS: z.number().min(0).default(60),
      nicknameIndicator: z.boolean().default(true),
      /** Q10: players may fire their own personal SFX and generic SFX only. */
      sfxCommand: z.enum(['everyone', 'gm']).default('everyone'),
      diceBot: z
        .object({ enabled: z.boolean().default(false), userId: OptionalDiscordId })
        .prefault({}),
    })
    .prefault({}),
  automation: z
    .object({ mode: Mode.default('suggest'), locked: z.boolean().default(false) })
    .prefault({}),
  mixer: z
    .object({
      master: z.number().min(0).max(100).default(80),
      layers: z
        .object({
          music: z.number().min(0).max(100).default(70),
          ambience: z.number().min(0).max(100).default(60),
          sfx: z.number().min(0).max(100).default(80),
        })
        .prefault({}),
      defaultCrossfadeS: z.number().min(0).max(30).default(3),
      ducking: z
        .object({
          enabled: z.boolean().default(true),
          depthDb: z.number().max(0).min(-40).default(-6),
          attackMs: z.number().min(1).default(150),
          releaseMs: z.number().min(1).default(800),
          sfxDuck: z.boolean().default(true),
          sfxDuckDb: z.number().max(0).min(-40).default(-4),
        })
        .prefault({}),
      limiter: z
        .object({
          ceilingDb: z.number().max(0).default(-1),
          lookaheadMs: z.number().min(0).max(20).default(5),
        })
        .prefault({}),
      loudness: z
        .object({
          musicLufs: z.number().default(-18),
          ambienceLufs: z.number().default(-24),
          sfxPeakDb: z.number().default(-3),
        })
        .prefault({}),
    })
    .prefault({}),
  ears: z
    .object({
      enabled: z.boolean().default(true),
      /** Rolling transcript memory in minutes. 0 = process and drop. Never on disk. */
      retentionMinutes: z.number().min(0).max(60).default(5),
      voskModel: z.string().default('vosk-model-small-en-us-0.15'),
      whisperModel: z.string().default('small.en'),
      silenceMs: z.number().min(100).default(800),
      heartbeatTimeoutS: z.number().min(1).default(5),
    })
    .prefault({}),
  triggers: z
    .object({
      minConfidence: z.number().min(0).max(1).default(0.6),
      fuzziness: z.number().min(0).max(1).default(0.2),
      cooldownS: z.number().min(0).default(4),
      /** Q4: ignore triggers briefly after an SFX that might bleed into mics. */
      selfHearGuardMs: z.number().min(0).default(300),
    })
    .prefault({}),
  scenes: z
    .object({
      halfLifeS: z.number().positive().default(30),
      threshold: z.number().positive().default(6),
      hysteresis: z.number().min(0).default(3),
      gmWeight: z.number().positive().default(1.5),
      suggestionTtlS: z.number().positive().default(20),
      autoUndoS: z.number().positive().default(10),
    })
    .prefault({}),
  selection: z
    .object({
      recencyMinutes: z.number().min(0).default(45),
      noRepeatCount: z.number().int().min(0).default(5),
      /** Q11: lyrics are excluded from automatic selection. */
      allowLyricsInAuto: z.boolean().default(false),
      skipPenaltyWithinS: z.number().min(0).default(15),
    })
    .prefault({}),
  inputs: z
    .object({
      discordVoice: z.boolean().default(true),
      discordText: z.boolean().default(true),
      localMic: z.boolean().default(false),
    })
    .prefault({}),
  outputs: z
    .object({
      discord: z.boolean().default(true),
      localSpeakers: z.boolean().default(false),
    })
    .prefault({}),
  ui: z
    .object({
      crt: z.boolean().default(true),
      scanlines: z.boolean().default(true),
      flicker: z.boolean().default(true),
      bloom: z.boolean().default(true),
      simulator: z.boolean().default(false),
    })
    .prefault({}),
  lan: z
    .object({
      enabled: z.boolean().default(false),
    })
    .prefault({}),
  library: z
    .object({
      recheckS: z.number().min(5).default(60),
    })
    .prefault({}),
  enrichment: z
    .object({
      acoustid: z.boolean().default(false),
      ollama: z.boolean().default(false),
      ollamaModel: z.string().default('llama3.1:8b'),
      ollamaSceneClassifier: z.boolean().default(false),
    })
    .prefault({}),
});
export type Settings = z.infer<typeof SettingsSchema>;

/* ------------------------------------------------------------------ */
/* scenes.yaml (SPEC §10.1)                                            */
/* ------------------------------------------------------------------ */

const IntensityRange = z
  .tuple([z.number().int().min(1).max(5), z.number().int().min(1).max(5)])
  .refine(([a, b]) => a <= b, 'intensity range must be [min, max]');

export const TrackQuerySchema = z.object({
  scenes: z.array(z.string()).optional(),
  moods: z.array(z.string()).optional(),
  settings: z.array(z.string()).optional(),
  factions: z.array(z.string()).optional(),
  intensity: IntensityRange.optional(),
  vocals: z.array(Vocals).optional(),
  /**
   * Explicit files (relative to a library root, or absolute) or track IDs.
   * Used for manual assignment before the library is tagged (SPEC §18 P2).
   */
  tracks: z.array(z.string()).optional(),
});
export type TrackQuery = z.infer<typeof TrackQuerySchema>;

const KeywordWeights = z.record(z.string(), z.number());

export const SceneSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'scene id must be lower-case kebab-case'),
  label: z.string(),
  music: TrackQuerySchema.default({}),
  ambience: z
    .object({
      auto: z.boolean().default(false),
      query: TrackQuerySchema.optional(),
      tracks: z.array(z.string()).optional(),
    })
    .optional(),
  crossfadeS: z.number().min(0).max(30).optional(),
  minDwellS: z.number().min(0).default(60),
  priority: z.number().int().min(0).max(100).default(10),
  manualOnly: z.boolean().default(false),
  fallback: z.string().optional(),
  entry: z
    .object({
      keywords: KeywordWeights.default({}),
      events: z.array(z.string()).default([]),
    })
    .prefault({}),
  exit: z
    .object({
      keywords: KeywordWeights.default({}),
      fallback: z.string().optional(),
    })
    .optional(),
});
export type Scene = z.infer<typeof SceneSchema>;

export const ScenesFileSchema = z
  .object({ scenes: z.array(SceneSchema).min(1) })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const [i, s] of file.scenes.entries()) {
      if (ids.has(s.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['scenes', i, 'id'],
          message: `duplicate scene id "${s.id}"`,
        });
      }
      ids.add(s.id);
    }
    for (const [i, s] of file.scenes.entries()) {
      for (const ref of [s.fallback, s.exit?.fallback]) {
        if (ref && !ids.has(ref)) {
          ctx.addIssue({
            code: 'custom',
            path: ['scenes', i],
            message: `fallback "${ref}" is not a known scene`,
          });
        }
      }
    }
  });
export type ScenesFile = z.infer<typeof ScenesFileSchema>;

/* ------------------------------------------------------------------ */
/* triggers.yaml (SPEC §9.5)                                           */
/* ------------------------------------------------------------------ */

export const SoundQuerySchema = z.object({
  category: z.string().optional(),
  phase: z.string().optional(),
  kind: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
export type SoundQuery = z.infer<typeof SoundQuerySchema>;

/** A specific file path (relative to a library root) or a tag query. */
export const SoundRefSchema = z.union([z.string().min(1), SoundQuerySchema]);
export type SoundRef = z.infer<typeof SoundRefSchema>;

const StateMap = z.record(z.string(), z.string());

export const TriggerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'trigger id must be lower-case kebab-case'),
  label: z.string().optional(),
  enabled: z.boolean().default(true),
  phrases: z.array(z.string().min(1)).default([]),
  subject: z.enum(['auto', 'speaker', 'none']).default('auto'),
  defaultSubject: z.string().default('none'),
  sound: SoundRefSchema.optional(),
  sting: SoundRefSchema.optional(),
  layer: Layer.default('sfx'),
  gainDb: z.number().default(0),
  setsState: StateMap.optional(),
  requiresState: StateMap.optional(),
  loop: z
    .object({
      sound: SoundRefSchema,
      layer: Layer.default('sfx'),
      gainDb: z.number().default(-12),
      while: z.string(),
      maxSeconds: z.number().positive().default(120),
    })
    .optional(),
  stopsLoopOf: z.string().optional(),
  cooldownS: z.number().min(0).optional(),
  subjectCooldownS: z.number().min(0).optional(),
  minConfidence: z.number().min(0).max(1).optional(),
  fuzziness: z.number().min(0).max(1).optional(),
  ignoreQuestions: z.boolean().default(true),
  speakers: z.array(z.string()).optional(),
  exceptSpeakers: z.array(z.string()).optional(),
  alsoNudgeScene: z.record(z.string(), z.number()).optional(),
});
export type Trigger = z.infer<typeof TriggerSchema>;

export const TriggersFileSchema = z
  .object({
    synonyms: z.record(z.string(), z.array(z.string())).default({}),
    triggers: z.array(TriggerSchema).default([]),
  })
  .superRefine((file, ctx) => {
    const ids = new Set<string>();
    for (const [i, t] of file.triggers.entries()) {
      if (ids.has(t.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['triggers', i, 'id'],
          message: `duplicate trigger id "${t.id}"`,
        });
      }
      ids.add(t.id);
    }
  });
export type TriggersFile = z.infer<typeof TriggersFileSchema>;

/* ------------------------------------------------------------------ */
/* players.yaml (SPEC §9.5)                                            */
/* ------------------------------------------------------------------ */

export const PlayerSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/, 'player id must be lower-case kebab-case'),
  discordUserId: z.string().regex(/^\d+$/).optional(),
  displayName: z.string(),
  character: z.string().optional(),
  aliases: z.array(z.string()).default([]),
  role: z.enum(['gm', 'player']).default('player'),
  /** triggerId (or `triggerId.loop`) -> file path relative to a library root. */
  sfx: z.record(z.string(), z.string()).default({}),
  colour: z.string().optional(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const PlayersFileSchema = z.object({ players: z.array(PlayerSchema).default([]) });
export type PlayersFile = z.infer<typeof PlayersFileSchema>;

/* ------------------------------------------------------------------ */
/* hooks.mtfbwy.yaml (SPEC §9.6)                                       */
/* ------------------------------------------------------------------ */

export const HookPhraseSchema = z.object({
  phrases: z.array(z.string()),
  /** e.g. `despair.spend`, `focus.gm`, `scene.nudge`, `scene.concluded` */
  event: z.string(),
  nudgeScene: z.record(z.string(), z.number()).optional(),
});

export const HooksFileSchema = z.object({
  system: z.string().default('mtfbwy'),
  despair: z
    .object({
      /** One intensity step per N Despair spent within the window. */
      spendPerStep: z.number().positive().default(2),
      windowMinutes: z.number().positive().default(5),
      maxSteps: z.number().int().min(0).max(4).default(2),
      interruptCost: z.number().int().positive().default(3),
    })
    .prefault({}),
  stings: z
    .object({
      despairInterrupt: SoundRefSchema.optional(),
      majorCrit: SoundRefSchema.optional(),
      majorCritFail: SoundRefSchema.optional(),
      minorCrit: SoundRefSchema.optional(),
      minorCritRateLimitS: z.number().min(0).default(60),
    })
    .prefault({}),
  focus: z
    .object({
      gmSwellInCombat: z.boolean().default(true),
    })
    .prefault({}),
  phrases: z.array(HookPhraseSchema).default([]),
  concludedScene: z.string().default('calm'),
});
export type HooksFile = z.infer<typeof HooksFileSchema>;

/* ------------------------------------------------------------------ */
/* vocabulary.yaml (SPEC §7.3)                                         */
/* ------------------------------------------------------------------ */

export const VocabularyFileSchema = z.object({
  terms: z.array(z.string()).default([]),
  places: z.array(z.string()).default([]),
  characters: z.array(z.string()).default([]),
});
export type VocabularyFile = z.infer<typeof VocabularyFileSchema>;

export const CONFIG_NAMES = [
  'settings',
  'scenes',
  'triggers',
  'players',
  'hooks',
  'vocabulary',
  'taxonomy',
] as const;
export const ConfigName = z.enum(CONFIG_NAMES);
export type ConfigName = z.infer<typeof ConfigName>;
