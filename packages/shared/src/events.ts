import { z } from 'zod';
import { Layer, Mode } from './taxonomy.ts';

/**
 * Typed event bus (SPEC §4.2). Every event is defined here once and forwarded to the
 * dashboard over WebSocket. Transcript events are memory-only and never persisted.
 */

export const HealthStatus = z.enum(['ok', 'degraded', 'down']);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const HealthComponent = z.enum(['discord', 'voice', 'ears', 'library', 'mixer']);
export type HealthComponent = z.infer<typeof HealthComponent>;

export const VoiceConnectionState = z.enum(['disconnected', 'connecting', 'ready', 'reconnecting']);
export type VoiceConnectionState = z.infer<typeof VoiceConnectionState>;

export const SceneChangeCause = z.enum(['manual', 'auto', 'accepted_suggestion', 'hook', 'revert']);
export type SceneChangeCause = z.infer<typeof SceneChangeCause>;

export const SuppressReason = z.enum([
  'cooldown',
  'negation',
  'question',
  'low_confidence',
  'muted_user',
  'state',
  'duplicate',
  'self_hear',
  'speaker_filter',
]);
export type SuppressReason = z.infer<typeof SuppressReason>;

export const Word = z.object({
  w: z.string(),
  start: z.number(),
  end: z.number(),
  conf: z.number(),
});

export const EventPayloads = {
  'voice.connection': z.object({
    state: VoiceConnectionState,
    channelId: z.string().nullable(),
    channelName: z.string().nullable().optional(),
    error: z.string().optional(),
  }),
  'voice.speaking': z.object({ userId: z.string(), speaking: z.boolean() }),
  'voice.level': z.object({ userId: z.string(), rms: z.number() }),
  'transcript.partial': z.object({
    utteranceId: z.string(),
    userId: z.string(),
    text: z.string(),
    confidence: z.number(),
    words: z.array(Word).default([]),
  }),
  'transcript.final': z.object({
    utteranceId: z.string(),
    userId: z.string(),
    text: z.string(),
    confidence: z.number(),
    words: z.array(Word).default([]),
  }),
  'trigger.matched': z.object({
    triggerId: z.string(),
    userId: z.string().nullable(),
    subject: z.string().nullable(),
    phrase: z.string(),
    confidence: z.number(),
    latencyMs: z.number().nullable(),
    seq: z.number().int(),
  }),
  'trigger.suppressed': z.object({
    triggerId: z.string(),
    userId: z.string().nullable(),
    reason: SuppressReason,
  }),
  'scene.scored': z.object({ scores: z.record(z.string(), z.number()) }),
  'scene.suggested': z.object({
    suggestionId: z.string(),
    sceneId: z.string(),
    confidence: z.number(),
    reasons: z.array(z.string()),
    expiresAt: z.number(),
  }),
  'scene.suggestion_resolved': z.object({
    suggestionId: z.string(),
    sceneId: z.string(),
    outcome: z.enum(['accepted', 'dismissed', 'expired']),
  }),
  'scene.changed': z.object({
    from: z.string().nullable(),
    to: z.string(),
    cause: SceneChangeCause,
    undoUntil: z.number().optional(),
  }),
  'track.started': z.object({
    layer: Layer,
    trackId: z.string(),
    title: z.string(),
    album: z.string().nullable().optional(),
    durationS: z.number().nullable(),
    reason: z.string(),
  }),
  'track.ended': z.object({ layer: Layer, trackId: z.string(), reason: z.string() }),
  'sfx.fired': z.object({
    sfxId: z.string(),
    title: z.string().optional(),
    userId: z.string().nullable().optional(),
    triggerId: z.string().nullable().optional(),
    subject: z.string().nullable().optional(),
  }),
  'mixer.state': z.object({
    master: z.number(),
    layers: z.record(
      Layer,
      z.object({ gain: z.number(), muted: z.boolean(), level: z.number(), duckDb: z.number() }),
    ),
    masterLevel: z.number(),
    limiting: z.boolean(),
    spectrum: z.array(z.number()),
  }),
  'game.focus': z.object({ holder: z.enum(['gm', 'heroes']), inCombat: z.boolean() }),
  'game.despair': z.object({
    pool: z.number().int(),
    delta: z.number().int(),
    tensionStep: z.number(),
  }),
  'game.roll': z.object({
    balance: z.number().int().min(1).max(12),
    despair: z.number().int().min(1).max(12),
    outcome: z.enum(['major_crit', 'major_crit_fail', 'minor_crit', 'normal']),
    userId: z.string().nullable().optional(),
  }),
  'library.scan': z.object({
    phase: z.enum(['scanning', 'analysing', 'done', 'error']),
    progress: z.number().min(0).max(1),
    added: z.number().int(),
    changed: z.number().int(),
    removed: z.number().int(),
    errors: z.number().int(),
    message: z.string().optional(),
  }),
  'library.gap': z.object({ sceneId: z.string(), message: z.string() }),
  'system.health': z.object({
    component: HealthComponent,
    status: HealthStatus,
    message: z.string(),
  }),
  'listening.state': z.object({ enabled: z.boolean(), excludedUserIds: z.array(z.string()) }),
  'automation.state': z.object({ mode: Mode, locked: z.boolean() }),
  'log.error': z.object({ source: z.string(), message: z.string() }),
} as const;

export type EventType = keyof typeof EventPayloads;
export type EventPayload<T extends EventType> = z.infer<(typeof EventPayloads)[T]>;

export interface BusEvent<T extends EventType = EventType> {
  type: T;
  ts: number;
  payload: EventPayload<T>;
}

export type AnyBusEvent = { [K in EventType]: BusEvent<K> }[EventType];

/** Events that may be persisted in the event log. Speech is never persisted. */
export const PERSISTED_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'trigger.matched',
  'trigger.suppressed',
  'scene.suggested',
  'scene.suggestion_resolved',
  'scene.changed',
  'track.started',
  'sfx.fired',
  'game.focus',
  'game.despair',
  'game.roll',
  'library.gap',
  'system.health',
  'log.error',
]);

/** High-frequency events: forwarded to the dashboard, never persisted or logged. */
export const EPHEMERAL_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
  'voice.level',
  'voice.speaking',
  'mixer.state',
  'scene.scored',
  'transcript.partial',
  'transcript.final',
]);

export function parseEvent<T extends EventType>(type: T, payload: unknown): EventPayload<T> {
  return EventPayloads[type].parse(payload) as EventPayload<T>;
}
