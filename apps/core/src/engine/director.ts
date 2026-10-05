import type {
  Mode,
  Scene,
  SceneChangeCause,
  Settings,
  Suggestion,
  TrackQuery,
} from '@cantina/shared';
import type { EventBus } from '../bus/bus.ts';
import type { Candidate, LibraryRepo, TrackRow } from '../library/repo.ts';
import type { Logger } from '../util/logger.ts';
import type { Rng } from '../util/random.ts';
import {
  adHocTrack,
  resolveLibraryPath,
  toPlayable,
  type Playback,
  type PlayableTrack,
} from './playback.ts';
import { SceneScorer } from './scenes/scorer.ts';
import { describeGap, selectTrack } from './selection.ts';
import type { SynonymMap } from './text/normalise.ts';

export interface DirectorDeps {
  repo: LibraryRepo;
  playback: Playback;
  bus: EventBus;
  log: Logger;
  scenes: () => Scene[];
  settings: () => Settings;
  roots: () => string[];
  rng: Rng;
  now?: () => number;
  synonyms?: SynonymMap | null;
}

/**
 * Music direction (SPEC §10): owns the current scene, picks tracks, manages ambience beds, and
 * turns scene scores into suggestions (Suggest) or changes (Auto) with one-click undo.
 */
export class Director {
  readonly scorer: SceneScorer;
  current: string | null = null;
  previous: string | null = null;
  private since = 0;
  mode: Mode;
  locked: boolean;
  suggestion: Suggestion | null = null;
  undoUntil: number | null = null;
  tensionStep = 0;
  private lastPlayed = new Map<string, number>();
  private history: string[] = [];
  private queued: PlayableTrack | null = null;
  private nextPreview: PlayableTrack | null = null;
  private musicStartedAt = 0;
  private lastScoredEmit = 0;
  private suggestionSeq = 0;
  private reportedGaps = new Set<string>();
  private readonly now: () => number;
  private changing: Promise<void> = Promise.resolve();

  constructor(private readonly d: DirectorDeps) {
    this.now = d.now ?? Date.now;
    const s = d.settings();
    this.mode = s.automation.mode;
    this.locked = s.automation.locked;
    this.scorer = new SceneScorer(d.scenes(), s.scenes, d.synonyms ?? null);
    d.playback.hooks.onMusicFinished = (track, reason) => {
      if (reason === 'error') this.d.repo.markBad(track.id, 'decode error');
      void this.playNext('ended');
    };
    d.playback.hooks.onBadTrack = (track, error) => {
      if (!track.id.startsWith('path:')) this.d.repo.markBad(track.id, error);
    };
    d.playback.hooks.onMusicStarted = (track) => {
      this.musicStartedAt = this.now();
      this.lastPlayed.set(track.id, this.now());
      this.history.unshift(track.id);
      this.history.length = Math.min(this.history.length, 20);
      if (!track.id.startsWith('path:')) this.d.repo.recordPlay(track.id, this.now());
      this.nextPreview = null;
    };
  }

  reconfigure(synonyms?: SynonymMap | null): void {
    this.scorer.update(this.d.scenes(), this.d.settings().scenes, synonyms ?? null);
  }

  scene(id: string | null = this.current): Scene | undefined {
    return id ? this.d.scenes().find((s) => s.id === id) : undefined;
  }

  /* --------------------------- scene changes -------------------------- */

  /** Change scene and start its music. Serialised so rapid clicks don't interleave. */
  setScene(sceneId: string, cause: SceneChangeCause): Promise<void> {
    const run = async () => {
      const scene = this.scene(sceneId);
      if (!scene) throw new Error(`Unknown scene "${sceneId}"`);
      if (sceneId === this.current && cause !== 'manual') return;
      const from = this.current;
      if (sceneId !== this.current) {
        this.previous = this.current;
        this.current = sceneId;
        this.since = this.now();
      }
      this.scorer.reset(sceneId);
      if (
        this.suggestion &&
        (cause !== 'accepted_suggestion' || this.suggestion.sceneId !== sceneId)
      ) {
        this.resolveSuggestion('expired');
      }
      this.undoUntil =
        cause === 'auto' ? this.now() + this.d.settings().scenes.autoUndoS * 1000 : null;
      this.d.bus.emit('scene.changed', {
        from,
        to: sceneId,
        cause,
        undoUntil: this.undoUntil ?? undefined,
      });
      this.d.log.info({ from, to: sceneId, cause }, 'scene changed');
      this.queued = null;
      this.nextPreview = null;
      await this.startMusic(scene);
      await this.updateAmbience(scene);
    };
    this.changing = this.changing.then(run, run);
    return this.changing;
  }

  /** Auto mode: revert to the previous scene within the undo window (SPEC §10.3). */
  async revert(): Promise<boolean> {
    if (!this.previous || !this.undoUntil || this.now() > this.undoUntil) return false;
    const target = this.previous;
    this.scorer.reset(this.current ?? '', 60_000, this.now());
    await this.setScene(target, 'revert');
    return true;
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    if (mode === 'manual' && this.suggestion) this.resolveSuggestion('expired');
    this.d.bus.emit('automation.state', { mode: this.mode, locked: this.locked });
  }

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.d.bus.emit('automation.state', { mode: this.mode, locked: this.locked });
  }

  /* ------------------------------ music ------------------------------ */

  private async startMusic(scene: Scene): Promise<void> {
    const track = this.pick(scene);
    if (!track) {
      this.d.log.warn({ scene: scene.id }, 'no music for scene');
      return;
    }
    const xf = scene.crossfadeS ?? this.d.settings().mixer.defaultCrossfadeS;
    const ok = await this.d.playback.playMusic(track, {
      crossfadeS: xf,
      reason: `scene:${scene.id}`,
    });
    if (!ok) await this.playNext('error');
  }

  /** Play the next track: the queued one, else a fresh pick for the current scene. */
  async playNext(reason: 'ended' | 'skip' | 'error'): Promise<void> {
    const scene = this.scene();
    const track = this.queued ?? this.nextPreview ?? (scene ? this.pick(scene) : null);
    this.queued = null;
    this.nextPreview = null;
    if (!track) return;
    const xf = reason === 'ended' ? Math.min(2, scene?.crossfadeS ?? 2) : (scene?.crossfadeS ?? 3);
    let attempts = 0;
    let t: PlayableTrack | null = track;
    while (t && attempts < 3) {
      if (await this.d.playback.playMusic(t, { crossfadeS: xf, reason })) return;
      attempts++;
      t = scene ? this.pick(scene) : null;
    }
  }

  /** GM skip. A skip within 15 s counts as negative feedback for this scene (SPEC §8.5). */
  async skip(): Promise<void> {
    const cur = this.d.playback.currentMusic;
    if (cur && this.current && !cur.track.id.startsWith('path:')) {
      const playedS = (this.now() - this.musicStartedAt) / 1000;
      if (playedS < this.d.settings().selection.skipPenaltyWithinS) {
        this.d.repo.adjustSceneWeight(cur.track.id, this.current, -0.15);
      }
    }
    await this.playNext('skip');
  }

  /** GM plays a specific track into the scene: small positive feedback. */
  async playTrack(
    trackId: string,
    transition: 'crossfade' | 'cut' | 'queue' = 'crossfade',
  ): Promise<PlayableTrack> {
    const row = this.d.repo.get(trackId);
    const track = row ? toPlayable(row) : this.adHoc(trackId);
    if (!track) throw new Error('Track not found');
    if (transition === 'queue') {
      this.queued = track;
      return track;
    }
    if (row && this.current) this.d.repo.adjustSceneWeight(row.id, this.current, 0.1);
    const ok = await this.d.playback.playMusic(track, {
      crossfadeS: transition === 'cut' ? 0.05 : (this.scene()?.crossfadeS ?? 3),
      reason: 'manual',
    });
    if (!ok) throw new Error(`Couldn't decode "${track.title}"`);
    return track;
  }

  queue(trackId: string): PlayableTrack {
    const row = this.d.repo.get(trackId);
    const t = row ? toPlayable(row) : this.adHoc(trackId);
    if (!t) throw new Error('Track not found');
    this.queued = t;
    return t;
  }

  feedback(trackId: string, vote: 'up' | 'down'): void {
    if (!this.current) return;
    this.d.repo.adjustSceneWeight(trackId, this.current, vote === 'up' ? 0.4 : -0.4);
  }

  /** What plays next (queued, or a preview pick that will be honoured). */
  peekNext(): PlayableTrack | null {
    if (this.queued) return this.queued;
    if (!this.nextPreview) {
      const scene = this.scene();
      if (scene) this.nextPreview = this.pick(scene);
    }
    return this.nextPreview;
  }

  private adHoc(ref: string): PlayableTrack | null {
    const p = resolveLibraryPath(ref.replace(/^path:/, ''), this.d.roots());
    return p ? adHocTrack(p) : null;
  }

  /** Track selection with the fallback chain: scene → fallback scene → calm → anything. */
  pick(scene: Scene): PlayableTrack | null {
    const s = this.d.settings();
    const chain: { id: string; q: TrackQuery }[] = [{ id: scene.id, q: scene.music }];
    const fb = this.scene(scene.fallback ?? scene.exit?.fallback ?? undefined);
    if (fb) chain.push({ id: fb.id, q: fb.music });
    const calm = this.scene('calm');
    if (calm && calm.id !== scene.id) chain.push({ id: 'calm', q: calm.music });
    for (const [i, link] of chain.entries()) {
      const candidates = this.candidatesFor(link.q, ['music']);
      const pick = selectTrack(candidates, link.q, {
        sceneId: scene.id,
        tensionStep: this.tensionStep,
        lastPlayed: this.lastPlayed,
        previous: this.history,
        noRepeatCount: s.selection.noRepeatCount,
        recencyMinutes: s.selection.recencyMinutes,
        allowLyrics: s.selection.allowLyricsInAuto,
        now: this.now(),
        rng: this.d.rng,
      });
      if (i === 0 && (!pick || pick.relaxed.length)) this.reportGap(scene.id, link.q, candidates);
      if (pick) return this.toTrack(pick.candidate.track);
    }
    return null;
  }

  private toTrack(row: TrackRow): PlayableTrack {
    return row.id.startsWith('path:') ? adHocTrack(row.path, row.kind) : toPlayable(row);
  }

  private candidatesFor(q: TrackQuery, kinds: ('music' | 'ambience')[]): Candidate[] {
    const cands = this.d.repo.candidates(q, kinds);
    if (!q.tracks?.length) return cands;
    // Explicit files not yet scanned into the library still play (SPEC §18 P2).
    const found = new Set(cands.map((c) => c.track.rel_path));
    for (const ref of q.tracks) {
      if (found.has(ref) || cands.some((c) => c.track.id === ref || c.track.path === ref)) continue;
      const p = resolveLibraryPath(ref, this.d.roots());
      if (!p) continue;
      cands.push({
        track: {
          id: `path:${p}`,
          path: p,
          rel_path: ref,
          title: ref,
          kind: kinds[0]!,
          missing: 0,
          bad: 0,
        } as TrackRow,
        tags: new Map(),
        sceneWeights: new Map(),
      });
    }
    return cands;
  }

  private reportGap(sceneId: string, q: TrackQuery, candidates: Candidate[]): void {
    const confirmed = candidates.filter((c) =>
      q.scenes?.some((sc) => c.tags.get('scenes')?.get(sc)?.status === 'confirmed'),
    ).length;
    const msg = describeGap(sceneId, q, confirmed);
    const key = `${sceneId}:${msg}`;
    if (this.reportedGaps.has(key)) return;
    this.reportedGaps.add(key);
    this.d.bus.emit('library.gap', { sceneId, message: msg });
  }

  /* ----------------------------- ambience ----------------------------- */

  private async updateAmbience(scene: Scene): Promise<void> {
    const amb = scene.ambience;
    // A scene that says nothing about ambience keeps the current beds (the rain doesn't stop for a fight).
    if (!amb) return;
    const playing = this.d.playback.ambienceTrackIds();
    let desired: PlayableTrack[] = [];
    if (amb?.tracks?.length) {
      desired = this.candidatesFor({ tracks: amb.tracks }, ['ambience'])
        .slice(0, 3)
        .map((c) => this.toTrack(c.track));
    } else if (amb?.query || amb?.auto) {
      const q: TrackQuery = amb.query ?? {
        scenes: [scene.id],
        ...(scene.music.settings ? { settings: scene.music.settings } : {}),
      };
      const already = this.d.repo
        .candidates(q, ['ambience'])
        .find((c) => playing.includes(c.track.id));
      if (already) desired = [this.toTrack(already.track)];
      else {
        const pick = selectTrack(
          this.d.repo.candidates(q, ['ambience']),
          { ...q, intensity: undefined },
          {
            sceneId: scene.id,
            tensionStep: 0,
            lastPlayed: new Map(),
            previous: [],
            noRepeatCount: 0,
            recencyMinutes: 0,
            allowLyrics: true,
            now: this.now(),
            rng: this.d.rng,
          },
        );
        // auto: keep whatever is playing if nothing matches the new scene.
        if (pick) desired = [this.toTrack(pick.candidate.track)];
        else if (amb.auto) return;
      }
    }
    const want = new Set(desired.map((t) => t.id));
    for (const id of playing) if (!want.has(id)) this.d.playback.stopAmbience(id, 4);
    for (const t of desired) if (!playing.includes(t.id)) await this.d.playback.addAmbience(t);
  }

  /* --------------------------- automation ---------------------------- */

  /** Called on every utterance (final transcripts and text messages). */
  onText(text: string, isGm: boolean): void {
    this.scorer.scanText(text, { isGm, now: this.now() });
  }

  nudge(sceneId: string, points: number, reason: string): void {
    this.scorer.add(sceneId, points, reason, this.now());
  }

  onEvent(key: string): void {
    this.scorer.onEvent(key, this.now());
  }

  /** Once a second: publish scores, expire suggestions, propose or apply changes. */
  tick(): void {
    const now = this.now();
    if (now - this.lastScoredEmit >= 1000) {
      this.lastScoredEmit = now;
      this.d.bus.emit('scene.scored', { scores: this.scorer.all(now) });
    }
    if (this.suggestion && now >= this.suggestion.expiresAt) this.resolveSuggestion('expired');
    if (this.undoUntil && now > this.undoUntil) this.undoUntil = null;
    if (this.mode === 'manual') return;
    const cand = this.scorer.candidate(this.current, this.since, now);
    if (!cand) return;
    if (this.mode === 'auto' && !this.locked) {
      void this.setScene(cand.sceneId, 'auto');
      return;
    }
    if (this.suggestion?.sceneId === cand.sceneId) {
      this.suggestion.confidence = cand.confidence;
      this.suggestion.reasons = cand.reasons;
      return;
    }
    if (this.suggestion) this.resolveSuggestion('expired');
    this.suggestion = {
      suggestionId: `sug_${++this.suggestionSeq}`,
      sceneId: cand.sceneId,
      confidence: cand.confidence,
      reasons: cand.reasons,
      expiresAt: now + this.d.settings().scenes.suggestionTtlS * 1000,
    };
    this.d.bus.emit('scene.suggested', { ...this.suggestion });
  }

  async accept(suggestionId?: string): Promise<boolean> {
    const s = this.suggestion;
    if (!s || (suggestionId && s.suggestionId !== suggestionId)) return false;
    this.resolveSuggestion('accepted');
    await this.setScene(s.sceneId, 'accepted_suggestion');
    return true;
  }

  dismiss(suggestionId?: string): boolean {
    const s = this.suggestion;
    if (!s || (suggestionId && s.suggestionId !== suggestionId)) return false;
    this.scorer.reset(s.sceneId, 60_000, this.now());
    this.resolveSuggestion('dismissed');
    return true;
  }

  private resolveSuggestion(outcome: 'accepted' | 'dismissed' | 'expired'): void {
    const s = this.suggestion;
    if (!s) return;
    this.suggestion = null;
    this.d.bus.emit('scene.suggestion_resolved', {
      suggestionId: s.suggestionId,
      sceneId: s.sceneId,
      outcome,
    });
  }

  setTension(step: number): void {
    this.tensionStep = step;
    this.nextPreview = null;
  }
}
