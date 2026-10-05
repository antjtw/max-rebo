import type {
  Player,
  Settings,
  SoundRef,
  SuppressReason,
  Trigger,
  TriggersFile,
} from '@cantina/shared';
import type { EventBus } from '../../bus/bus.ts';
import { buildSynonyms, normalise, type SynonymMap } from '../text/normalise.ts';
import {
  compilePattern,
  matchPattern,
  type MatchResult,
  type NameEntry,
  type Pattern,
  type SlotVocab,
} from './pattern.ts';

/**
 * Trigger engine (SPEC §9): phrases → actions (SFX, loops, state, scene nudges), with negation and
 * question guards, confidence thresholds, cooldowns, partial/final dedupe, speaker filters, subject
 * resolution (speaker vs named character) and per-player sound overrides.
 */

export interface TriggerInput {
  text: string;
  /** Discord user ID, or a player id for the simulator / local mic. */
  userId: string | null;
  utteranceId: string;
  confidence: number;
  kind: 'partial' | 'final';
  source: 'voice' | 'text' | 'sim' | 'mic';
  /** When speech ended (for latency), if known. */
  speechEndedAt?: number | null;
}

export interface TriggerDecision {
  triggerId: string;
  phrase: string;
  score: number;
  confidence: number;
  subject: string | null;
  fired: boolean;
  reason: SuppressReason | null;
}

export interface FireRequest {
  trigger: Trigger;
  subject: string | null; // player id or null
  speaker: Player | null;
  sound: SoundRef | null;
  /** players.yaml override path for this subject, if any. */
  overridePath: string | null;
  loop: {
    sound: SoundRef | null;
    overridePath: string | null;
    gainDb: number;
    maxSeconds: number;
    stateKey: string;
  } | null;
  userId: string | null;
}

export interface TriggerDeps {
  bus: EventBus;
  now: () => number;
  /** Play the trigger's sound (and loop). Returns false if nothing could be resolved. */
  fire: (req: FireRequest) => Promise<boolean> | boolean;
  stopLoops: (stateKey: string) => void;
  nudgeScene: (sceneId: string, points: number, reason: string) => void;
  onEvent: (key: string) => void;
}

const NEGATORS = new Set(['not', 'never', 'no', 'stop', 'without', 'unless', 'if']);
const QUESTION_STARTERS = new Set([
  'should',
  'shall',
  'can',
  'could',
  'would',
  'do',
  'does',
  'did',
  'will',
  'what',
  'how',
  'why',
  'when',
  'is',
  'are',
  'may',
  'might',
]);
const FIRST_PERSON = new Set(['i', 'my', 'me', 'im', 'mine', 'myself']);

interface Compiled {
  trigger: Trigger;
  patterns: Pattern[];
}

export class TriggerEngine {
  private compiled: Compiled[] = [];
  private syn: SynonymMap | null = null;
  private synonymSource: Record<string, string[]> = {};
  private players: Player[] = [];
  private vocab: SlotVocab = { character: [], player: [] };
  private settings: Settings['triggers'];
  private lastFired = new Map<string, number>(); // triggerId → ts
  private lastFiredSubject = new Map<string, number>(); // triggerId:subject → ts
  private firedUtterances = new Map<string, Set<string>>(); // utteranceId → triggerIds
  private state = new Map<string, string>();
  private lastSfxAt = -Infinity;
  private seq = 0;
  errors: string[] = [];

  constructor(
    private readonly deps: TriggerDeps,
    file: TriggersFile,
    players: Player[],
    settings: Settings['triggers'],
  ) {
    this.settings = settings;
    this.update(file, players, settings);
  }

  get synonyms(): SynonymMap | null {
    return this.syn;
  }

  update(file: TriggersFile, players: Player[], settings: Settings['triggers']): void {
    this.settings = settings;
    this.syn = buildSynonyms(file.synonyms);
    this.synonymSource = file.synonyms;
    this.players = players;
    this.errors = [];
    const character: NameEntry[] = [];
    const player: NameEntry[] = [];
    for (const p of players) {
      if (p.character) character.push({ tokens: normalise(p.character, this.syn), id: p.id });
      for (const a of p.aliases) character.push({ tokens: normalise(a, this.syn), id: p.id });
      player.push({ tokens: normalise(p.displayName, this.syn), id: p.id });
    }
    this.vocab = { character: character.filter((c) => c.tokens.length), player, known: new Set() };
    this.compiled = [];
    for (const t of file.triggers) {
      const patterns: Pattern[] = [];
      for (const ph of t.phrases) {
        try {
          patterns.push(compilePattern(ph, this.syn));
        } catch (err) {
          this.errors.push(`${t.id}: ${(err as Error).message}`);
        }
      }
      this.compiled.push({ trigger: t, patterns });
      for (const p of patterns) {
        for (const el of p.elements)
          if (el.kind === 'alt')
            for (const o of el.options) for (const w of o) this.vocab.known!.add(w);
      }
    }
  }

  /** Words the keyword recogniser should know (Vosk grammar). */
  vocabulary(): string[] {
    const words = new Set<string>();
    for (const c of this.compiled)
      for (const p of c.trigger.phrases)
        for (const w of normalise(p.replace(/[()[\]{}|]/g, ' '))) words.add(w);
    for (const e of [...this.vocab.character, ...this.vocab.player])
      for (const w of e.tokens) words.add(w);
    for (const [canon, variants] of Object.entries(this.synonymSource)) {
      for (const w of [canon, ...variants].flatMap((x) => normalise(x))) words.add(w);
    }
    return [...words];
  }

  playerByUser(userId: string | null): Player | null {
    if (!userId) return null;
    return this.players.find((p) => p.discordUserId === userId || p.id === userId) ?? null;
  }

  /** Called whenever an SFX plays, for the self-hear guard (Q4). */
  noteSfx(at = this.deps.now()): void {
    this.lastSfxAt = at;
  }

  getState(key: string): string | undefined {
    return this.state.get(key);
  }

  resetState(): void {
    for (const key of this.state.keys()) this.deps.stopLoops(key);
    this.state.clear();
  }

  /** A loop ended on its own (safety stop): its state flips back. */
  loopEnded(stateKey: string): void {
    if (this.state.get(stateKey) === 'on') this.state.set(stateKey, 'off');
  }

  /** Dry run for the phrase tester: which triggers match, with scores. No side effects. */
  test(text: string, speakerId: string | null): TriggerDecision[] {
    return this.evaluate(
      {
        text,
        userId: speakerId,
        utteranceId: `test-${this.seq}`,
        confidence: 1,
        kind: 'final',
        source: 'sim',
      },
      true,
    );
  }

  /** Process one utterance (partial or final). Fires what qualifies; returns every decision. */
  async process(input: TriggerInput): Promise<TriggerDecision[]> {
    const decisions = this.evaluate(input, false);
    for (const d of decisions) {
      if (!d.fired) continue;
      const c = this.compiled.find((x) => x.trigger.id === d.triggerId)!;
      await this.fire(c.trigger, d, input);
    }
    this.gcUtterances();
    return decisions;
  }

  private evaluate(input: TriggerInput, dryRun: boolean): TriggerDecision[] {
    const now = this.deps.now();
    const raw = input.text;
    const tokens = normalise(raw, this.syn);
    if (tokens.length === 0) return [];
    const speaker = this.playerByUser(input.userId);
    const out: TriggerDecision[] = [];
    const isQuestion = /\?\s*$/.test(raw.trim());
    const already = this.firedUtterances.get(input.utteranceId);

    for (const { trigger: t, patterns } of this.compiled) {
      if (!t.enabled || patterns.length === 0) continue;
      let best: MatchResult | null = null;
      for (const p of patterns) {
        const m = matchPattern(p, tokens, this.vocab, t.fuzziness ?? this.settings.fuzziness);
        if (m && (!best || m.score > best.score)) best = m;
      }
      if (!best || best.score < 0.5) continue;

      const confidence = Math.round(input.confidence * best.score * 1000) / 1000;
      const subject = this.resolveSubject(t, best, tokens, speaker);
      const d: TriggerDecision = {
        triggerId: t.id,
        phrase: best.pattern,
        score: Math.round(best.score * 1000) / 1000,
        confidence,
        subject,
        fired: false,
        reason: null,
      };
      out.push(d);

      const reason = this.guard(
        t,
        best,
        tokens,
        isQuestion,
        speaker,
        subject,
        confidence,
        now,
        already,
      );
      if (reason) {
        d.reason = reason;
        if (!dryRun && reason !== 'duplicate') {
          this.deps.bus.emit('trigger.suppressed', {
            triggerId: t.id,
            userId: input.userId,
            reason,
          });
        }
        continue;
      }
      d.fired = true;
      if (!dryRun) {
        let set = this.firedUtterances.get(input.utteranceId);
        if (!set) this.firedUtterances.set(input.utteranceId, (set = new Set()));
        set.add(t.id);
        this.lastFired.set(t.id, now);
        this.lastFiredSubject.set(`${t.id}:${subject ?? ''}`, now);
        this.deps.bus.emit('trigger.matched', {
          triggerId: t.id,
          userId: input.userId,
          subject,
          phrase: best.pattern,
          confidence,
          latencyMs: input.speechEndedAt != null ? Math.max(0, now - input.speechEndedAt) : null,
          seq: ++this.seq,
        });
      }
    }
    return out;
  }

  private guard(
    t: Trigger,
    m: MatchResult,
    tokens: string[],
    isQuestion: boolean,
    speaker: Player | null,
    subject: string | null,
    confidence: number,
    now: number,
    already: Set<string> | undefined,
  ): SuppressReason | null {
    if (already?.has(t.id)) return 'duplicate';
    if (t.speakers?.length && !(speaker && t.speakers.includes(speaker.id)))
      return 'speaker_filter';
    if (t.exceptSpeakers?.length && speaker && t.exceptSpeakers.includes(speaker.id))
      return 'speaker_filter';
    // Negation: a negator within 3 tokens before the verb (SPEC §9.2.5).
    const from = Math.max(0, m.verbIndex - 3);
    for (let i = from; i < m.verbIndex; i++) if (NEGATORS.has(tokens[i]!)) return 'negation';
    if (t.ignoreQuestions) {
      const lead = tokens.slice(Math.max(0, m.start - 4), m.verbIndex);
      if (isQuestion || lead.some((w) => QUESTION_STARTERS.has(w))) return 'question';
    }
    if (confidence < (t.minConfidence ?? this.settings.minConfidence)) return 'low_confidence';
    if (now - this.lastSfxAt < this.settings.selfHearGuardMs) return 'self_hear';
    const cd = (t.cooldownS ?? this.settings.cooldownS) * 1000;
    if (now - (this.lastFired.get(t.id) ?? -Infinity) < cd && !t.subjectCooldownS)
      return 'cooldown';
    if (t.subjectCooldownS != null) {
      const last = this.lastFiredSubject.get(`${t.id}:${subject ?? ''}`) ?? -Infinity;
      if (now - last < t.subjectCooldownS * 1000) return 'cooldown';
    }
    if (t.requiresState) {
      for (const [k, v] of Object.entries(t.requiresState)) {
        if ((this.state.get(this.stateKey(k, subject)) ?? 'off') !== v) return 'state';
      }
    }
    return null;
  }

  /** SPEC §9.3: named character → speaker if first person → default. */
  private resolveSubject(
    t: Trigger,
    m: MatchResult,
    tokens: string[],
    speaker: Player | null,
  ): string | null {
    if (t.subject === 'none') return null;
    if (t.subject === 'speaker') return speaker?.id ?? null;
    if (m.slots.character) return m.slots.character;
    if (m.slots.player) return m.slots.player;
    // Named character anywhere in the utterance (e.g. "Kael, ignite your saber" is not first person).
    const window = tokens.slice(Math.max(0, m.start - 3), m.end);
    if (window.some((w) => FIRST_PERSON.has(w)) || m.start === 0) return speaker?.id ?? null;
    return t.defaultSubject === 'none' ? null : t.defaultSubject;
  }

  private stateKey(template: string, subject: string | null): string {
    return template.replace('{subject}', subject ?? 'table');
  }

  private async fire(t: Trigger, d: TriggerDecision, input: TriggerInput): Promise<void> {
    const subjectPlayer = d.subject ? (this.players.find((p) => p.id === d.subject) ?? null) : null;
    let loop: FireRequest['loop'] = null;
    if (t.loop) {
      const m = /^\s*(\S+)\s*==\s*(\S+)\s*$/.exec(t.loop.while);
      const key = this.stateKey(m?.[1] ?? `{subject}.${t.id}`, d.subject);
      loop = {
        sound: t.loop.sound,
        overridePath: subjectPlayer?.sfx[`${t.id}.loop`] ?? null,
        gainDb: t.loop.gainDb,
        maxSeconds: t.loop.maxSeconds,
        stateKey: key,
      };
    }
    // State changes first so a retract stops the hum even if its own sound is missing.
    if (t.setsState) {
      for (const [k, v] of Object.entries(t.setsState)) {
        const key = this.stateKey(k, d.subject);
        const prev = this.state.get(key);
        this.state.set(key, v);
        if (prev === 'on' && v !== 'on') this.deps.stopLoops(key);
      }
    }
    if (t.stopsLoopOf) this.deps.stopLoops(this.stateKey(t.stopsLoopOf, d.subject));
    if (t.sound || t.sting || loop || subjectPlayer?.sfx[t.id]) {
      const req: FireRequest = {
        trigger: t,
        subject: d.subject,
        speaker: this.playerByUser(input.userId),
        sound: t.sound ?? t.sting ?? null,
        overridePath: subjectPlayer?.sfx[t.id] ?? null,
        loop,
        userId: input.userId,
      };
      await this.deps.fire(req);
      this.noteSfx();
    }
    for (const [scene, pts] of Object.entries(t.alsoNudgeScene ?? {}))
      this.deps.nudgeScene(scene, pts, `trigger ${t.id}`);
    this.deps.onEvent(`trigger.${t.id}`);
  }

  private gcUtterances(): void {
    if (this.firedUtterances.size > 500) {
      const keys = [...this.firedUtterances.keys()].slice(0, 250);
      for (const k of keys) this.firedUtterances.delete(k);
    }
  }
}
