import type { HooksFile, SoundRef } from '@cantina/shared';
import type { EventBus } from '../../bus/bus.ts';
import { normalise, type SynonymMap } from '../text/normalise.ts';
import { compilePattern, matchPattern, type Pattern } from '../triggers/pattern.ts';

/**
 * Game hooks (SPEC §9.6). `GameHooks` is the generic interface; MTFBWY is the first preset.
 * MTFBWY terms: the Focus (never "spotlight"), Despair, Balance, Dyad dice (2d12). No initiative.
 */
export interface GameHooks {
  readonly system: string;
  onText(text: string, isGm: boolean): void;
  onDiceBotMessage(content: string, userId: string | null): boolean;
  state(): { despairPool: number; focus: 'gm' | 'heroes'; inCombat: boolean; tensionStep: number };
  tick(): void;
}

export interface HookActions {
  bus: EventBus;
  now: () => number;
  playSting: (ref: SoundRef, reason: string) => void;
  setTension: (step: number) => void;
  nudgeScene: (sceneId: string, points: number, reason: string) => void;
  currentScene: () => string | null;
  /** Brief ambience swell when the GM takes the Focus in combat. */
  swellAmbience: () => void;
}

export type RollOutcome = 'major_crit' | 'major_crit_fail' | 'minor_crit' | 'normal';

/** Classify a Dyad roll: double 12 is a major crit, double 1 a major crit fail, other doubles minor. */
export function classifyRoll(balance: number, despair: number): RollOutcome {
  if (balance !== despair) return 'normal';
  if (balance === 12) return 'major_crit';
  if (balance === 1) return 'major_crit_fail';
  return 'minor_crit';
}

/** Parse a dice bot's result message. Accepts "Balance 7 / Despair 12" or "2d12: [7, 12]". */
export function parseDyadRoll(content: string): { balance: number; despair: number } | null {
  const text = content.replace(/[*_`~]/g, '');
  const named = /balance\D{0,12}?(\d{1,2})[\s\S]{0,40}?despair\D{0,12}?(\d{1,2})/i.exec(text);
  if (named) return valid(Number(named[1]), Number(named[2]));
  const dyad = /2d12[^\d]{0,20}(\d{1,2})\D{1,4}(\d{1,2})/i.exec(text);
  if (dyad) return valid(Number(dyad[1]), Number(dyad[2]));
  return null;
}

function valid(b: number, d: number): { balance: number; despair: number } | null {
  return b >= 1 && b <= 12 && d >= 1 && d <= 12 ? { balance: b, despair: d } : null;
}

const COMBAT_SCENES = new Set(['combat', 'boss', 'chase']);

export class MtfbwyHooks implements GameHooks {
  readonly system = 'mtfbwy';
  private pool = 0;
  private spends: { at: number; n: number }[] = [];
  private focus: 'gm' | 'heroes' = 'heroes';
  private tensionStep = 0;
  private lastMinorCrit = -Infinity;
  private phrases: { pattern: Pattern; event: string; nudge?: Record<string, number> }[] = [];

  constructor(
    private cfg: HooksFile,
    private readonly a: HookActions,
    private syn: SynonymMap | null = null,
  ) {
    this.compile();
  }

  update(cfg: HooksFile, syn: SynonymMap | null = this.syn): void {
    this.cfg = cfg;
    this.syn = syn;
    this.compile();
  }

  private compile(): void {
    this.phrases = [];
    for (const p of this.cfg.phrases) {
      for (const ph of p.phrases) {
        try {
          this.phrases.push({
            pattern: compilePattern(ph, this.syn),
            event: p.event,
            nudge: p.nudgeScene,
          });
        } catch {
          // invalid phrases are reported by config validation in the dashboard
        }
      }
    }
  }

  get inCombat(): boolean {
    return COMBAT_SCENES.has(this.a.currentScene() ?? '');
  }

  state() {
    return {
      despairPool: this.pool,
      focus: this.focus,
      inCombat: this.inCombat,
      tensionStep: this.tensionStep,
    };
  }

  /** Change the Despair pool. Negative deltas are spends. */
  despair(delta: number): void {
    const now = this.a.now();
    this.pool = Math.max(0, this.pool + delta);
    if (delta < 0) {
      const n = -delta;
      this.spends.push({ at: now, n });
      if (n >= this.cfg.despair.interruptCost && this.cfg.stings.despairInterrupt) {
        this.a.playSting(this.cfg.stings.despairInterrupt, 'despair interrupt');
      }
    } else if (delta > 0) {
      this.a.nudgeScene('tension', delta, 'Despair rises');
    }
    this.recomputeTension();
    this.a.bus.emit('game.despair', { pool: this.pool, delta, tensionStep: this.tensionStep });
  }

  /** Spending Despair without a tracked pool (e.g. heard "I spend 2 Despair"). */
  spend(n: number): void {
    this.despair(-Math.max(1, n));
  }

  setFocus(holder: 'gm' | 'heroes'): void {
    if (holder === this.focus) return;
    this.focus = holder;
    if (holder === 'gm' && this.inCombat && this.cfg.focus.gmSwellInCombat) this.a.swellAmbience();
    this.a.bus.emit('game.focus', { holder, inCombat: this.inCombat });
  }

  roll(balance: number, despair: number, userId: string | null = null): RollOutcome {
    const outcome = classifyRoll(balance, despair);
    const now = this.a.now();
    const s = this.cfg.stings;
    if (outcome === 'major_crit' && s.majorCrit) this.a.playSting(s.majorCrit, 'major crit');
    if (outcome === 'major_crit_fail' && s.majorCritFail)
      this.a.playSting(s.majorCritFail, 'major crit fail');
    if (
      outcome === 'minor_crit' &&
      s.minorCrit &&
      now - this.lastMinorCrit >= s.minorCritRateLimitS * 1000
    ) {
      this.lastMinorCrit = now;
      this.a.playSting(s.minorCrit, 'minor crit');
    }
    this.a.bus.emit('game.roll', { balance, despair, outcome, userId });
    return outcome;
  }

  /** Scene concluded or a full rest: shift towards calm, and clear tension. */
  concludeScene(): void {
    this.spends = [];
    this.recomputeTension();
    this.a.nudgeScene(this.cfg.concludedScene, 8, 'scene concluded');
    this.a.bus.emit('game.despair', { pool: this.pool, delta: 0, tensionStep: this.tensionStep });
  }

  onText(text: string, isGm: boolean): void {
    const tokens = normalise(text, this.syn);
    if (!tokens.length) return;
    const seen = new Set<string>();
    for (const p of this.phrases) {
      if (seen.has(p.event)) continue;
      const m = matchPattern(p.pattern, tokens, { character: [], player: [] }, 0.15);
      if (!m || m.score < 0.85) continue;
      seen.add(p.event);
      switch (p.event) {
        case 'focus.gm':
          if (isGm) this.setFocus('gm');
          break;
        case 'focus.heroes':
          if (isGm) this.setFocus('heroes');
          break;
        case 'despair.spend':
          if (isGm && m.slots.number) this.spend(Number(m.slots.number));
          break;
        case 'despair.spend_one':
          if (isGm) this.spend(1);
          break;
        case 'scene.concluded':
          this.concludeScene();
          break;
        case 'scene.nudge':
          for (const [scene, pts] of Object.entries(p.nudge ?? {}))
            this.a.nudgeScene(scene, pts, `"${p.pattern.source}"`);
          break;
      }
    }
  }

  onDiceBotMessage(content: string, userId: string | null): boolean {
    const r = parseDyadRoll(content);
    if (!r) return false;
    this.roll(r.balance, r.despair, userId);
    return true;
  }

  /** Expire old spends so tension eases back down. */
  tick(): void {
    const before = this.tensionStep;
    this.recomputeTension();
    if (this.tensionStep !== before) {
      this.a.bus.emit('game.despair', { pool: this.pool, delta: 0, tensionStep: this.tensionStep });
    }
  }

  private recomputeTension(): void {
    const now = this.a.now();
    const windowMs = this.cfg.despair.windowMinutes * 60_000;
    this.spends = this.spends.filter((s) => now - s.at <= windowMs);
    const spent = this.spends.reduce((a, s) => a + s.n, 0);
    const step = Math.min(
      this.cfg.despair.maxSteps,
      Math.floor(spent / this.cfg.despair.spendPerStep),
    );
    if (step !== this.tensionStep) {
      this.tensionStep = step;
      this.a.setTension(step);
    }
  }
}
