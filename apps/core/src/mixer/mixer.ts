import { LAYERS, type Layer } from '@cantina/shared';
import { gainToLinear } from '@cantina/shared';
import {
  dbToLin,
  DuckEnvelope,
  Fade,
  FRAME_FLOATS,
  FRAME_SAMPLES,
  GainSmoother,
  Limiter,
  rms,
  SAMPLE_RATE,
} from './dsp.ts';
import type { PcmSource } from './sources.ts';
import { SpectrumAnalyser } from './spectrum.ts';

/**
 * Three-layer mixer (SPEC §6): music (1 active + 1 fading), ambience (≤ 3 beds), SFX (≤ 8 voices),
 * summed through per-layer gain, music ducking, master gain and a lookahead limiter.
 * `renderFrame()` is synchronous and allocation-light; a clock calls it every 20 ms.
 */

export type EndReason = 'ended' | 'stopped' | 'stolen' | 'replaced' | 'error' | 'panic';

export interface VoiceMeta {
  trackId: string;
  title: string;
  album?: string | null;
  sting?: boolean;
  userId?: string | null;
  triggerId?: string | null;
  subject?: string | null;
  /** Loops started by a trigger carry the state key that keeps them alive. */
  stateKey?: string;
}

export interface Voice {
  readonly id: string;
  readonly layer: Layer;
  readonly source: PcmSource;
  readonly meta: VoiceMeta;
  readonly startedFrame: number;
  gain: number;
  fade: Fade | null;
  stopping: boolean;
  endReason: EndReason | null;
  level: number;
  maxFrames: number | null;
  framesPlayed: number;
}

export interface MixerOptions {
  master?: number;
  layers?: Partial<Record<Layer, number>>;
  ceilingDb?: number;
  lookaheadMs?: number;
  ducking?: Partial<DuckingOptions>;
  limits?: { ambience?: number; sfx?: number };
}

export interface DuckingOptions {
  enabled: boolean;
  depthDb: number;
  attackMs: number;
  releaseMs: number;
  sfxDuck: boolean;
  sfxDuckDb: number;
  stingDuckDb: number;
}

export interface PlayOptions {
  gainDb?: number;
  fadeInS?: number;
  /** Music: crossfade length. Defaults to the mixer's default crossfade. */
  crossfadeS?: number;
  maxSeconds?: number;
}

export interface LayerState {
  gain: number;
  muted: boolean;
  level: number;
  duckDb: number;
}

export interface MixerSnapshot {
  master: number;
  layers: Record<Layer, LayerState>;
  masterLevel: number;
  limiting: boolean;
  spectrum: number[];
  paused: boolean;
}

interface LayerBus {
  gain: number; // UI 0–100
  muted: boolean;
  smoother: GainSmoother;
  voices: Voice[];
  level: number;
}

export class Mixer {
  private readonly layers: Record<Layer, LayerBus>;
  private masterUi: number;
  private readonly masterSmoother: GainSmoother;
  private readonly limiter: Limiter;
  private readonly duck: DuckEnvelope;
  private ducking: DuckingOptions;
  private readonly limits: { ambience: number; sfx: number };
  private readonly out = new Float32Array(FRAME_FLOATS);
  private readonly bus = new Float32Array(FRAME_FLOATS);
  private readonly tmp = new Float32Array(FRAME_FLOATS);
  private readonly spectrum = new SpectrumAnalyser();
  private lastSpectrum: number[] = new Array<number>(24).fill(0);
  private frame = 0;
  private nextId = 1;
  private speechActive = false;
  private masterLevel = 0;
  private limitingFrames = 0;
  private readonly pauseSmoother = new GainSmoother(1);
  private musicPaused = false;
  defaultCrossfadeS = 3;
  onVoiceEnd: (voice: Voice, reason: EndReason) => void = () => {};

  constructor(opts: MixerOptions = {}) {
    const mk = (layer: Layer): LayerBus => {
      const g = opts.layers?.[layer] ?? 80;
      return {
        gain: g,
        muted: false,
        smoother: new GainSmoother(gainToLinear(g)),
        voices: [],
        level: 0,
      };
    };
    this.layers = { music: mk('music'), ambience: mk('ambience'), sfx: mk('sfx') };
    this.masterUi = opts.master ?? 80;
    this.masterSmoother = new GainSmoother(gainToLinear(this.masterUi));
    this.limiter = new Limiter(opts.ceilingDb ?? -1, opts.lookaheadMs ?? 5);
    this.ducking = {
      enabled: true,
      depthDb: -6,
      attackMs: 150,
      releaseMs: 800,
      sfxDuck: true,
      sfxDuckDb: -4,
      stingDuckDb: -10,
      ...opts.ducking,
    };
    this.duck = new DuckEnvelope(this.ducking.attackMs, this.ducking.releaseMs);
    this.limits = { ambience: opts.limits?.ambience ?? 3, sfx: opts.limits?.sfx ?? 8 };
  }

  /* ---------------------------- controls ---------------------------- */

  setLayerGain(layer: Layer, gain: number): void {
    this.layers[layer].gain = Math.max(0, Math.min(100, gain));
  }
  setLayerMuted(layer: Layer, muted: boolean): void {
    this.layers[layer].muted = muted;
  }
  setMaster(gain: number): void {
    this.masterUi = Math.max(0, Math.min(100, gain));
  }
  setDucking(d: Partial<DuckingOptions>): void {
    this.ducking = { ...this.ducking, ...d };
    this.duck.attackMs = this.ducking.attackMs;
    this.duck.releaseMs = this.ducking.releaseMs;
  }
  get duckingOptions(): DuckingOptions {
    return { ...this.ducking };
  }
  /** Any non-excluded user speaking (SPEC §6.3). */
  setSpeechActive(active: boolean): void {
    this.speechActive = active;
  }
  setMusicPaused(paused: boolean): void {
    this.musicPaused = paused;
  }
  get paused(): boolean {
    return this.musicPaused;
  }
  get frameCount(): number {
    return this.frame;
  }
  get timeS(): number {
    return (this.frame * FRAME_SAMPLES) / SAMPLE_RATE;
  }

  voices(layer?: Layer): Voice[] {
    if (layer) return [...this.layers[layer].voices];
    return LAYERS.flatMap((l) => this.layers[l].voices);
  }

  /** The current (non-stopping) music voice. */
  get music(): Voice | null {
    return this.layers.music.voices.find((v) => !v.stopping) ?? null;
  }

  /* ---------------------------- playback ---------------------------- */

  /** Start music, crossfading out whatever is playing (equal-power, SPEC §6.4). */
  playMusic(source: PcmSource, meta: VoiceMeta, opts: PlayOptions = {}): Voice {
    const bus = this.layers.music;
    const xf = opts.crossfadeS ?? this.defaultCrossfadeS;
    // Only one fading voice at a time: anything already fading is cut now.
    for (const v of bus.voices) {
      if (v.stopping) this.end(v, 'replaced');
    }
    for (const v of bus.voices) {
      if (!v.stopping) this.fadeOut(v, xf, 'replaced');
    }
    const voice = this.createVoice(
      'music',
      source,
      meta,
      opts.gainDb ?? 0,
      opts.fadeInS ?? xf,
      opts.maxSeconds,
    );
    bus.voices.push(voice);
    this.musicPaused = false;
    return voice;
  }

  /** Add an ambience bed. The oldest bed fades out if all slots are taken. */
  addAmbience(source: PcmSource, meta: VoiceMeta, opts: PlayOptions = {}): Voice {
    const bus = this.layers.ambience;
    const active = bus.voices.filter((v) => !v.stopping);
    if (active.length >= this.limits.ambience) this.fadeOut(active[0]!, 2, 'replaced');
    const voice = this.createVoice(
      'ambience',
      source,
      meta,
      opts.gainDb ?? 0,
      opts.fadeInS ?? 2,
      opts.maxSeconds,
    );
    bus.voices.push(voice);
    return voice;
  }

  /** Fire an SFX one-shot or loop. Steals the quietest (then oldest) voice when full. */
  playSfx(source: PcmSource, meta: VoiceMeta, opts: PlayOptions = {}): Voice {
    const bus = this.layers.sfx;
    const active = bus.voices.filter((v) => !v.stopping);
    if (active.length >= this.limits.sfx) {
      const victim = [...active].sort(
        (a, b) => a.level - b.level || a.startedFrame - b.startedFrame,
      )[0]!;
      this.fadeOut(victim, FRAME_SAMPLES / SAMPLE_RATE, 'stolen');
    }
    const voice = this.createVoice(
      'sfx',
      source,
      meta,
      opts.gainDb ?? 0,
      opts.fadeInS ?? 0,
      opts.maxSeconds,
    );
    bus.voices.push(voice);
    return voice;
  }

  stopVoice(id: string, fadeS = 0.3, reason: EndReason = 'stopped'): boolean {
    const v = this.voices().find((x) => x.id === id);
    if (!v) return false;
    this.fadeOut(v, fadeS, reason);
    return true;
  }

  stopLayer(layer: Layer, fadeS = 1.5, reason: EndReason = 'stopped'): void {
    for (const v of this.layers[layer].voices) if (!v.stopping) this.fadeOut(v, fadeS, reason);
  }

  /** Everything to silence over 1 s (SPEC §6.4). */
  panic(fadeS = 1): void {
    for (const l of LAYERS) this.stopLayer(l, fadeS, 'panic');
  }

  private createVoice(
    layer: Layer,
    source: PcmSource,
    meta: VoiceMeta,
    gainDb: number,
    fadeInS: number,
    maxSeconds?: number,
  ): Voice {
    const fadeSamples = Math.round(fadeInS * SAMPLE_RATE);
    return {
      id: `v${this.nextId++}`,
      layer,
      source,
      meta,
      startedFrame: this.frame,
      gain: dbToLin(gainDb),
      fade: fadeSamples > 0 ? new Fade(0, 1, fadeSamples) : null,
      stopping: false,
      endReason: null,
      level: 1, // treat new voices as loud so they aren't stolen immediately
      maxFrames: maxSeconds ? Math.round(maxSeconds * SAMPLE_RATE) : null,
      framesPlayed: 0,
    };
  }

  private fadeOut(v: Voice, seconds: number, reason: EndReason): void {
    if (v.stopping) return;
    const current = v.fade ? v.fade.value : 1;
    v.fade = new Fade(current, 0, Math.max(1, Math.round(seconds * SAMPLE_RATE)));
    v.stopping = true;
    v.endReason = reason;
  }

  private end(v: Voice, reason: EndReason): void {
    const bus = this.layers[v.layer];
    const i = bus.voices.indexOf(v);
    if (i >= 0) bus.voices.splice(i, 1);
    v.source.close();
    this.onVoiceEnd(v, reason);
  }

  /* ----------------------------- render ----------------------------- */

  /** Mix one 20 ms frame. Returns a view that is reused on the next call. */
  renderFrame(): Float32Array {
    const out = this.out;
    out.fill(0);
    const sfxActive = this.layers.sfx.voices.some((v) => !v.stopping && !v.meta.stateKey);
    const stingActive = this.layers.sfx.voices.some((v) => !v.stopping && v.meta.sting);

    let duckTarget = 0;
    if (this.ducking.enabled && this.speechActive)
      duckTarget = Math.min(duckTarget, this.ducking.depthDb);
    if (this.ducking.sfxDuck && sfxActive)
      duckTarget = Math.min(duckTarget, this.ducking.sfxDuckDb);
    if (stingActive) duckTarget = Math.min(duckTarget, this.ducking.stingDuckDb);
    const [duck0, duck1] = this.duck.step(duckTarget);
    const [pause0, pause1] = this.pauseSmoother.step(this.musicPaused ? 0 : 1, 0.5);

    for (const layer of LAYERS) {
      const bus = this.layers[layer];
      const buf = this.bus;
      buf.fill(0);
      const skipRead = layer === 'music' && this.musicPaused && pause1 < 1e-3;
      if (!skipRead) {
        for (const v of [...bus.voices]) this.renderVoice(v, buf);
      }
      const target = bus.muted ? 0 : gainToLinear(bus.gain);
      let [g0, g1] = bus.smoother.step(target);
      if (layer === 'music') {
        g0 *= duck0 * pause0;
        g1 *= duck1 * pause1;
      }
      const n = FRAME_SAMPLES;
      for (let i = 0; i < n; i++) {
        const g = g0 + ((g1 - g0) * i) / n;
        out[i * 2] = out[i * 2]! + buf[i * 2]! * g;
        out[i * 2 + 1] = out[i * 2 + 1]! + buf[i * 2 + 1]! * g;
      }
      bus.level = rms(buf) * g1;
    }

    const [m0, m1] = this.masterSmoother.step(gainToLinear(this.masterUi));
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const g = m0 + ((m1 - m0) * i) / FRAME_SAMPLES;
      out[i * 2] = out[i * 2]! * g;
      out[i * 2 + 1] = out[i * 2 + 1]! * g;
    }
    this.limiter.process(out);
    this.limitingFrames = this.limiter.minGain < 0.98 ? 10 : Math.max(0, this.limitingFrames - 1);
    this.masterLevel = rms(out);
    this.spectrum.push(out);
    if (this.frame % 5 === 0) this.lastSpectrum = this.spectrum.compute();
    this.frame++;
    return out;
  }

  private renderVoice(v: Voice, acc: Float32Array): void {
    const tmp = this.tmp;
    const got = v.source.read(tmp, FRAME_SAMPLES);
    if (got < FRAME_SAMPLES) tmp.fill(0, got * 2);
    let sum = 0;
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      const fg = v.fade ? v.fade.next() : 1;
      const g = fg * v.gain;
      const l = tmp[i * 2]! * g;
      const r = tmp[i * 2 + 1]! * g;
      acc[i * 2] = acc[i * 2]! + l;
      acc[i * 2 + 1] = acc[i * 2 + 1]! + r;
      sum += l * l + r * r;
    }
    v.level = Math.sqrt(sum / FRAME_FLOATS);
    v.framesPlayed += got;
    if (v.fade?.done && !v.stopping) v.fade = null;

    if (v.stopping && v.fade?.done) {
      this.end(v, v.endReason ?? 'stopped');
    } else if (v.source.error) {
      this.end(v, 'error');
    } else if (v.source.ended && got < FRAME_SAMPLES) {
      this.end(v, 'ended');
    } else if (v.maxFrames != null && v.framesPlayed >= v.maxFrames && !v.stopping) {
      this.fadeOut(v, 0.5, 'stopped');
    }
  }

  snapshot(): MixerSnapshot {
    const layers = {} as Record<Layer, LayerState>;
    for (const l of LAYERS) {
      const b = this.layers[l];
      layers[l] = {
        gain: b.gain,
        muted: b.muted,
        level: Math.round(b.level * 1000) / 1000,
        duckDb: l === 'music' ? Math.round(this.duck.db * 10) / 10 : 0,
      };
    }
    return {
      master: this.masterUi,
      layers,
      masterLevel: Math.round(this.masterLevel * 1000) / 1000,
      limiting: this.limitingFrames > 0,
      spectrum: this.lastSpectrum,
      paused: this.musicPaused,
    };
  }
}
