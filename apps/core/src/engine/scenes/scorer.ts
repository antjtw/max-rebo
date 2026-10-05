import type { Scene, Settings } from '@cantina/shared';
import { findPhrase, normalise, type SynonymMap } from '../text/normalise.ts';

/**
 * Scene scoring (SPEC §10.2): keyword hits, trigger nudges and hooks add weighted points to scenes,
 * decaying exponentially (half-life 30 s). A scene becomes a candidate when it clears the threshold,
 * beats the current scene by the hysteresis margin, and the current scene has dwelt long enough,
 * unless it is high priority with a score of at least twice the threshold.
 */

interface Entry {
  value: number;
  at: number;
}

export interface ScoreReason {
  sceneId: string;
  points: number;
  reason: string;
  at: number;
}

export interface SceneCandidate {
  sceneId: string;
  score: number;
  confidence: number;
  reasons: string[];
}

type ScorerSettings = Settings['scenes'];

export class SceneScorer {
  private scores = new Map<string, Entry>();
  private reasons: ScoreReason[] = [];
  private compiled: {
    sceneId: string;
    tokens: string[];
    points: number;
    label: string;
    exit: boolean;
  }[] = [];
  private suppressed = new Map<string, number>();

  constructor(
    private scenes: Scene[],
    private cfg: ScorerSettings,
    private syn: SynonymMap | null = null,
  ) {
    this.compile();
  }

  update(scenes: Scene[], cfg: ScorerSettings, syn: SynonymMap | null = this.syn): void {
    this.scenes = scenes;
    this.cfg = cfg;
    this.syn = syn;
    this.compile();
  }

  private compile(): void {
    this.compiled = [];
    for (const s of this.scenes) {
      for (const [kw, pts] of Object.entries(s.entry.keywords)) {
        this.compiled.push({
          sceneId: s.id,
          tokens: normalise(kw, this.syn),
          points: pts,
          label: kw,
          exit: false,
        });
      }
      const fb = s.exit?.fallback ?? s.fallback;
      if (s.exit && fb) {
        for (const [kw, pts] of Object.entries(s.exit.keywords)) {
          this.compiled.push({
            sceneId: fb,
            tokens: normalise(kw, this.syn),
            points: pts,
            label: `${kw} (ends ${s.label})`,
            exit: true,
          });
        }
      }
    }
  }

  private decayed(e: Entry | undefined, now: number): number {
    if (!e) return 0;
    const dt = Math.max(0, now - e.at) / 1000;
    return e.value * Math.pow(0.5, dt / this.cfg.halfLifeS);
  }

  score(sceneId: string, now: number): number {
    return this.decayed(this.scores.get(sceneId), now);
  }

  all(now: number): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.scenes) out[s.id] = Math.round(this.score(s.id, now) * 100) / 100;
    return out;
  }

  add(sceneId: string, points: number, reason: string, now: number): void {
    if (!this.scenes.some((s) => s.id === sceneId) || points === 0) return;
    const v = this.score(sceneId, now) + points;
    this.scores.set(sceneId, { value: Math.max(0, v), at: now });
    this.reasons.push({ sceneId, points, reason, at: now });
    if (this.reasons.length > 200) this.reasons.splice(0, this.reasons.length - 200);
  }

  /** Scan an utterance for scene keywords. Returns the hits applied. */
  scanText(text: string, opts: { isGm: boolean; now: number }): ScoreReason[] {
    const toks = normalise(text, this.syn);
    const hits: ScoreReason[] = [];
    for (const k of this.compiled) {
      if (findPhrase(toks, k.tokens) >= 0) {
        const pts = k.points * (opts.isGm ? this.cfg.gmWeight : 1);
        this.add(k.sceneId, pts, `"${k.label}"`, opts.now);
        hits.push({ sceneId: k.sceneId, points: pts, reason: k.label, at: opts.now });
      }
    }
    return hits;
  }

  /** Events listed in a scene's `entry.events` (e.g. `trigger.blaster-fire`). */
  onEvent(eventKey: string, now: number, points = 2): void {
    for (const s of this.scenes)
      if (s.entry.events.includes(eventKey)) this.add(s.id, points, eventKey, now);
  }

  /** After a scene change or dismissal, clear that scene's score (and optionally suppress it briefly). */
  reset(sceneId: string, suppressForMs = 0, now = 0): void {
    this.scores.delete(sceneId);
    if (suppressForMs > 0) this.suppressed.set(sceneId, now + suppressForMs);
  }

  candidate(current: string | null, currentSince: number, now: number): SceneCandidate | null {
    const t = this.cfg.threshold;
    const curScene = this.scenes.find((s) => s.id === current);
    const curScore = current ? this.score(current, now) : 0;
    const dwellOk = !curScene || (now - currentSince) / 1000 >= curScene.minDwellS;
    let best: SceneCandidate | null = null;
    for (const s of this.scenes) {
      if (s.id === current || s.manualOnly) continue;
      if ((this.suppressed.get(s.id) ?? 0) > now) continue;
      const sc = this.score(s.id, now);
      if (sc < t || sc - curScore < this.cfg.hysteresis) continue;
      const breakIn = s.priority >= 80 && sc >= 2 * t;
      if (!dwellOk && !breakIn) continue;
      if (!best || sc > best.score) {
        best = {
          sceneId: s.id,
          score: sc,
          confidence: Math.min(0.99, Math.round((sc / (sc + t)) * 100) / 100),
          reasons: this.reasonsFor(s.id, now),
        };
      }
    }
    return best;
  }

  reasonsFor(sceneId: string, now: number): string[] {
    const window = this.cfg.halfLifeS * 3 * 1000;
    const agg = new Map<string, number>();
    for (const r of this.reasons) {
      if (r.sceneId !== sceneId || now - r.at > window) continue;
      agg.set(r.reason, (agg.get(r.reason) ?? 0) + r.points);
    }
    return [...agg.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([k, v]) => `${k} +${Math.round(v * 10) / 10}`);
  }
}
