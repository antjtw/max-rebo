import { z } from 'zod';
import { HealthComponent, HealthStatus, VoiceConnectionState } from './events.ts';
import { Kind, Layer, Mode, TagFacet, TagSource, TagStatus, Vocals } from './taxonomy.ts';

/* ------------------------------------------------------------------ */
/* Requests (SPEC §13)                                                 */
/* ------------------------------------------------------------------ */

export const VoiceJoinRequest = z.object({ channelId: z.string() });
export const SceneRequest = z.object({ sceneId: z.string() });
export const ModeRequest = z.object({ mode: Mode });
export const LockRequest = z.object({ locked: z.boolean() });
export const LayerRequest = z.object({
  gain: z.number().min(0).max(100).optional(),
  muted: z.boolean().optional(),
});
export const MasterRequest = z.object({ gain: z.number().min(0).max(100) });
export const DuckingRequest = z.object({
  enabled: z.boolean().optional(),
  depthDb: z.number().min(-40).max(0).optional(),
});
export const MusicPlayRequest = z.object({
  trackId: z.string(),
  transition: z.enum(['crossfade', 'cut', 'queue']).default('crossfade'),
});
export const MusicQueueRequest = z.object({ trackId: z.string() });
export const MusicPauseRequest = z.object({ paused: z.boolean() });
export const FeedbackRequest = z.object({ trackId: z.string(), vote: z.enum(['up', 'down']) });
export const SfxFireRequest = z
  .object({
    sfxId: z.string().optional(),
    triggerId: z.string().optional(),
    subject: z.string().optional(),
  })
  .refine((r) => r.sfxId || r.triggerId, 'sfxId or triggerId is required');
export const StopRequest = z.object({ layer: Layer.optional() });
export const ListenRequest = z.object({
  enabled: z.boolean().optional(),
  userId: z.string().optional(),
  userEnabled: z.boolean().optional(),
});
export const SimSayRequest = z.object({
  playerId: z.string(),
  text: z.string().min(1).max(500),
  final: z.boolean().default(true),
});
export const DespairRequest = z.object({ delta: z.number().int().min(-10).max(10) });
export const FocusRequest = z.object({ holder: z.enum(['gm', 'heroes']) });
export const RollRequest = z.object({
  balance: z.number().int().min(1).max(12),
  despair: z.number().int().min(1).max(12),
});
export const TestPhraseRequest = z.object({
  text: z.string().max(500),
  playerId: z.string().optional(),
});
export const LanPinRequest = z.object({ pin: z.string().regex(/^\d{6}$/) });

/* ------------------------------------------------------------------ */
/* Library                                                             */
/* ------------------------------------------------------------------ */

export const TagRow = z.object({
  facet: z.string(),
  value: z.string(),
  source: TagSource,
  confidence: z.number(),
  status: TagStatus,
});
export type TagRow = z.infer<typeof TagRow>;

export const TrackSummary = z.object({
  id: z.string(),
  path: z.string(),
  relPath: z.string(),
  title: z.string(),
  album: z.string().nullable(),
  artist: z.string().nullable(),
  durationS: z.number().nullable(),
  kind: Kind,
  intensity: z.number().nullable(),
  vocals: Vocals.nullable(),
  loopable: z.boolean().nullable(),
  diegetic: z.boolean().nullable(),
  gainDb: z.number().nullable(),
  lufs: z.number().nullable(),
  energy: z.number().nullable(),
  rating: z.number().nullable(),
  missing: z.boolean(),
  tags: z.array(TagRow),
  rationale: z.string().nullable().optional(),
});
export type TrackSummary = z.infer<typeof TrackSummary>;

export const LibraryQuery = z.object({
  q: z.string().optional(),
  kind: Kind.optional(),
  facet: TagFacet.optional(),
  value: z.string().optional(),
  status: z.enum(['inferred', 'confirmed', 'needs_review']).optional(),
  limit: z.coerce.number().int().min(1).max(5000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});

export const LibraryPatch = z.object({
  kind: Kind.optional(),
  intensity: z.number().int().min(1).max(5).nullable().optional(),
  vocals: Vocals.nullable().optional(),
  loopable: z.boolean().nullable().optional(),
  diegetic: z.boolean().nullable().optional(),
  rating: z.number().int().min(-1).max(5).nullable().optional(),
  notes: z.string().nullable().optional(),
  introSkipS: z.number().min(0).nullable().optional(),
  setTags: z
    .array(z.object({ facet: TagFacet, value: z.string(), status: TagStatus.default('confirmed') }))
    .optional(),
  confirmAllInferred: z.boolean().optional(),
});
export type LibraryPatch = z.infer<typeof LibraryPatch>;

export const BulkConfirmRequest = z.object({ trackIds: z.array(z.string()).min(1) });

/** Tagging proposal format shared by the Claude Code pass and Ollama (SPEC §8.4). */
export const TagProposal = z.object({
  trackId: z.string(),
  proposed: z.object({
    kind: Kind.optional(),
    scenes: z.array(z.string()).optional(),
    moods: z.array(z.string()).optional(),
    intensity: z.number().int().min(1).max(5).optional(),
    settings: z.array(z.string()).optional(),
    factions: z.array(z.string()).optional(),
    category: z.array(z.string()).optional(),
    phase: z.array(z.string()).optional(),
    vocals: Vocals.optional(),
    loopable: z.boolean().optional(),
    diegetic: z.boolean().optional(),
  }),
  confidence: z.number().min(0).max(1),
  rationale: z.string().default(''),
  sources: z.array(z.string()).default([]),
});
export type TagProposal = z.infer<typeof TagProposal>;
export const TagProposalFile = z.array(TagProposal);

/* ------------------------------------------------------------------ */
/* State snapshot (GET /api/state)                                     */
/* ------------------------------------------------------------------ */

export const NowPlaying = z.object({
  trackId: z.string(),
  title: z.string(),
  album: z.string().nullable(),
  durationS: z.number().nullable(),
  positionS: z.number(),
});
export type NowPlaying = z.infer<typeof NowPlaying>;

export const PlayerView = z.object({
  id: z.string(),
  userId: z.string().nullable(),
  displayName: z.string(),
  character: z.string().nullable(),
  role: z.enum(['gm', 'player']),
  inVoice: z.boolean(),
  speaking: z.boolean(),
  listening: z.boolean(),
  colour: z.string().nullable(),
});
export type PlayerView = z.infer<typeof PlayerView>;

export const SceneView = z.object({
  id: z.string(),
  label: z.string(),
  manualOnly: z.boolean(),
  priority: z.number(),
  score: z.number(),
});
export type SceneView = z.infer<typeof SceneView>;

export const SfxButton = z.object({
  id: z.string(),
  label: z.string(),
  category: z.string().nullable(),
  playerId: z.string().nullable(),
  character: z.string().nullable(),
  triggerId: z.string().nullable(),
  hotkey: z.string().nullable(),
});
export type SfxButton = z.infer<typeof SfxButton>;

export const Suggestion = z.object({
  suggestionId: z.string(),
  sceneId: z.string(),
  confidence: z.number(),
  reasons: z.array(z.string()),
  expiresAt: z.number(),
});
export type Suggestion = z.infer<typeof Suggestion>;

export const VoiceChannelView = z.object({
  id: z.string(),
  name: z.string(),
  members: z.array(z.object({ userId: z.string(), name: z.string(), bot: z.boolean() })),
});

export const StateSnapshot = z.object({
  version: z.string(),
  startedAt: z.number(),
  voice: z.object({
    state: VoiceConnectionState,
    channelId: z.string().nullable(),
    channelName: z.string().nullable(),
    channels: z.array(VoiceChannelView),
  }),
  automation: z.object({ mode: Mode, locked: z.boolean() }),
  scene: z.object({
    current: z.string().nullable(),
    previous: z.string().nullable(),
    undoUntil: z.number().nullable(),
    scenes: z.array(SceneView),
    suggestion: Suggestion.nullable(),
    tensionStep: z.number(),
  }),
  mixer: z.object({
    master: z.number(),
    paused: z.boolean(),
    ducking: z.object({ enabled: z.boolean(), depthDb: z.number() }),
    layers: z.record(Layer, z.object({ gain: z.number(), muted: z.boolean(), level: z.number() })),
  }),
  nowPlaying: z.object({
    music: NowPlaying.nullable(),
    next: NowPlaying.nullable(),
    ambience: z.array(NowPlaying),
  }),
  players: z.array(PlayerView),
  listening: z.object({ enabled: z.boolean(), excludedUserIds: z.array(z.string()) }),
  game: z.object({
    despairPool: z.number().int(),
    focus: z.enum(['gm', 'heroes']),
    inCombat: z.boolean(),
  }),
  soundboard: z.array(SfxButton),
  health: z.record(HealthComponent, z.object({ status: HealthStatus, message: z.string() })),
  ui: z.object({
    crt: z.boolean(),
    scanlines: z.boolean(),
    flicker: z.boolean(),
    bloom: z.boolean(),
    simulator: z.boolean(),
  }),
  lan: z.object({ enabled: z.boolean() }),
});
export type StateSnapshot = z.infer<typeof StateSnapshot>;

/** Messages over the dashboard WebSocket. */
export const WsServerMessage = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), state: StateSnapshot }),
  z.object({
    kind: z.literal('event'),
    type: z.string(),
    ts: z.number(),
    payload: z.unknown(),
  }),
]);
export type WsServerMessage = z.infer<typeof WsServerMessage>;

export const ApiError = z.object({
  error: z.string(),
  details: z.array(z.string()).optional(),
});
export type ApiError = z.infer<typeof ApiError>;
