import { describe, expect, it } from 'vitest';
import { dbToLin, FRAME_SAMPLES, peak, rms, SAMPLE_RATE } from './dsp.ts';
import { Mixer, type EndReason, type Voice } from './mixer.ts';
import { BufferSource } from './sources.ts';

function constant(value: number, seconds: number, loop = false): BufferSource {
  const n = Math.round(seconds * SAMPLE_RATE);
  return new BufferSource(new Float32Array(n * 2).fill(value), `c${value}`, {
    loop,
    loopCrossfadeS: 0,
  });
}

function sine(freq: number, amp: number, seconds: number): BufferSource {
  const n = Math.round(seconds * SAMPLE_RATE);
  const d = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    const v = amp * Math.sin((2 * Math.PI * freq * i) / SAMPLE_RATE);
    d[i * 2] = v;
    d[i * 2 + 1] = v;
  }
  return new BufferSource(d, `sine${freq}`);
}

/** Unity-gain mixer: every fader at 100 (0 dB), no ducking, so maths is easy to check. */
function unityMixer(): Mixer {
  return new Mixer({
    master: 100,
    layers: { music: 100, ambience: 100, sfx: 100 },
    ducking: { enabled: false, sfxDuck: false },
  });
}

function run(m: Mixer, seconds: number): Float32Array {
  const frames = Math.round((seconds * SAMPLE_RATE) / FRAME_SAMPLES);
  let last: Float32Array = new Float32Array(0);
  for (let i = 0; i < frames; i++) last = m.renderFrame();
  return last;
}

const meta = (id: string) => ({ trackId: id, title: id });

describe('Mixer', () => {
  it('renders 20 ms stereo frames', () => {
    const m = unityMixer();
    expect(m.renderFrame().length).toBe(FRAME_SAMPLES * 2);
    expect(m.timeS).toBeCloseTo(0.02, 5);
  });

  it('plays an SFX over music without interrupting it', () => {
    const m = unityMixer();
    m.playMusic(constant(0.1, 10), meta('music'), { crossfadeS: 0, fadeInS: 0 });
    run(m, 0.2);
    m.playSfx(constant(0.2, 0.5), meta('sfx'));
    const frame = run(m, 0.2);
    expect(frame[100]).toBeCloseTo(0.3, 3);
    const after = run(m, 1);
    expect(after[100]).toBeCloseTo(0.1, 3);
    expect(m.music?.meta.trackId).toBe('music');
  });

  it('crossfades music with equal power and ends the old voice', () => {
    const m = unityMixer();
    const ended: [string, EndReason][] = [];
    m.onVoiceEnd = (v, r) => ended.push([v.meta.trackId, r]);
    m.playMusic(constant(0.4, 30), meta('a'), { fadeInS: 0 });
    run(m, 0.5);
    m.playMusic(constant(0.4, 30), meta('b'), { crossfadeS: 1 });
    // Mid-crossfade: two correlated equal-power fades sum above either alone (≈0.4·√2).
    const mid = run(m, 0.5);
    expect(mid[0]!).toBeGreaterThan(0.5);
    run(m, 0.6);
    expect(ended).toEqual([['a', 'replaced']]);
    expect(m.voices('music').map((v) => v.meta.trackId)).toEqual(['b']);
    expect(run(m, 0.1)[0]).toBeCloseTo(0.4, 3);
  });

  it('keeps only one fading music voice', () => {
    const m = unityMixer();
    m.playMusic(constant(0.1, 30), meta('a'), { fadeInS: 0 });
    m.playMusic(constant(0.1, 30), meta('b'), { crossfadeS: 3 });
    m.playMusic(constant(0.1, 30), meta('c'), { crossfadeS: 3 });
    expect(m.voices('music').map((v) => v.meta.trackId)).toEqual(['b', 'c']);
  });

  it('ducks music under speech by the configured depth', () => {
    const m = new Mixer({
      master: 100,
      layers: { music: 100 },
      ducking: { enabled: true, depthDb: -6, attackMs: 150, releaseMs: 800, sfxDuck: false },
    });
    m.playMusic(constant(0.2, 30), meta('m'), { fadeInS: 0 });
    run(m, 0.2);
    m.setSpeechActive(true);
    const ducked = run(m, 0.5);
    expect(ducked[0]!).toBeCloseTo(0.2 * dbToLin(-6), 3);
    expect(m.snapshot().layers.music.duckDb).toBe(-6);
    m.setSpeechActive(false);
    run(m, 0.3);
    expect(m.snapshot().layers.music.duckDb).toBeLessThan(0); // release is slower than attack
    const released = run(m, 1);
    expect(released[0]!).toBeCloseTo(0.2, 3);
  });

  it('ducks music under SFX when enabled', () => {
    const m = new Mixer({
      master: 100,
      layers: { music: 100, sfx: 100 },
      ducking: { enabled: false, sfxDuck: true, sfxDuckDb: -4, attackMs: 20 },
    });
    m.playMusic(constant(0.2, 30), meta('m'), { fadeInS: 0 });
    m.playSfx(constant(0, 2), meta('silent-sfx'));
    const f = run(m, 0.5);
    expect(f[0]!).toBeCloseTo(0.2 * dbToLin(-4), 3);
  });

  it('steals the quietest SFX voice when all 8 are busy', () => {
    const m = unityMixer();
    const ended: [string, EndReason][] = [];
    m.onVoiceEnd = (v: Voice, r) => ended.push([v.meta.trackId, r]);
    for (let i = 0; i < 8; i++) m.playSfx(constant(i === 3 ? 0.001 : 0.05, 5), meta(`s${i}`));
    run(m, 0.1);
    m.playSfx(constant(0.05, 5), meta('s8'));
    run(m, 0.1);
    expect(ended).toEqual([['s3', 'stolen']]);
    expect(m.voices('sfx').length).toBe(8);
  });

  it('limits ambience to three beds', () => {
    const m = unityMixer();
    for (let i = 0; i < 4; i++)
      m.addAmbience(constant(0.01, 30, true), meta(`a${i}`), { fadeInS: 0 });
    run(m, 2.5);
    expect(m.voices('ambience').map((v) => v.meta.trackId)).toEqual(['a1', 'a2', 'a3']);
  });

  it('never clips: the limiter holds the ceiling with everything loud', () => {
    const m = unityMixer();
    m.playMusic(sine(110, 0.9, 5), meta('m'), { fadeInS: 0 });
    for (let i = 0; i < 3; i++)
      m.addAmbience(sine(220 + i * 50, 0.8, 5), meta(`a${i}`), { fadeInS: 0 });
    for (let i = 0; i < 8; i++) m.playSfx(sine(600 + i * 70, 0.9, 5), meta(`s${i}`));
    const ceiling = dbToLin(-1) + 1e-6;
    for (let i = 0; i < 100; i++) expect(peak(m.renderFrame())).toBeLessThanOrEqual(ceiling);
    expect(m.snapshot().limiting).toBe(true);
  });

  it('panic fades everything to silence in about a second', () => {
    const m = unityMixer();
    const reasons: EndReason[] = [];
    m.onVoiceEnd = (_v, r) => reasons.push(r);
    m.playMusic(constant(0.2, 30), meta('m'), { fadeInS: 0 });
    m.addAmbience(constant(0.1, 30, true), meta('a'), { fadeInS: 0 });
    m.playSfx(constant(0.1, 30), meta('s'));
    run(m, 0.1);
    m.panic(1);
    run(m, 0.5);
    expect(m.voices().length).toBe(3);
    const after = run(m, 0.6);
    expect(m.voices().length).toBe(0);
    expect(rms(after)).toBe(0);
    expect(reasons).toEqual(['panic', 'panic', 'panic']);
  });

  it('reports ended sources and stops capped loops', () => {
    const m = unityMixer();
    const ended: [string, EndReason][] = [];
    m.onVoiceEnd = (v, r) => ended.push([v.meta.trackId, r]);
    m.playSfx(constant(0.1, 0.1), meta('short'));
    m.playSfx(constant(0.1, 1, true), meta('loop'), { maxSeconds: 0.5 });
    run(m, 1.5);
    expect(ended).toEqual([
      ['short', 'ended'],
      ['loop', 'stopped'],
    ]);
  });

  it('pauses and resumes music without losing position', () => {
    const m = unityMixer();
    const v = m.playMusic(constant(0.2, 30), meta('m'), { fadeInS: 0 });
    run(m, 1);
    const pos = v.source.positionS;
    m.setMusicPaused(true);
    const silent = run(m, 0.5);
    expect(rms(silent)).toBeLessThan(1e-4);
    expect(v.source.positionS - pos).toBeLessThan(0.2);
    m.setMusicPaused(false);
    expect(run(m, 0.3)[0]).toBeCloseTo(0.2, 3);
  });

  it('applies layer faders and mute', () => {
    const m = unityMixer();
    m.playMusic(constant(0.2, 30), meta('m'), { fadeInS: 0 });
    m.setLayerMuted('music', true);
    expect(rms(run(m, 0.5))).toBeLessThan(1e-4);
    m.setLayerMuted('music', false);
    m.setLayerGain('music', 50);
    // 50 on the fader is −12 dB.
    expect(run(m, 0.5)[0]!).toBeCloseTo(0.2 * dbToLin(-12), 3);
  });

  it('produces a spectrum for the scope', () => {
    const m = unityMixer();
    m.playMusic(sine(1000, 0.5, 5), meta('m'), { fadeInS: 0 });
    run(m, 0.5);
    const s = m.snapshot().spectrum;
    expect(s.length).toBe(24);
    const max = s.indexOf(Math.max(...s));
    expect(max).toBeGreaterThan(8);
    expect(max).toBeLessThan(18);
  });
});
