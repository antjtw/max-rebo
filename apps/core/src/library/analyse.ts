import { spawn } from 'node:child_process';
import { fft } from '../mixer/spectrum.ts';
import { applyHeuristics } from './scanner.ts';
import type { LibraryRepo, TrackRow } from './repo.ts';

/**
 * Background audio analysis (SPEC §8.3), resumable: loudness and true peak (FFmpeg ebur128) for
 * gain offsets, an energy curve and mini waveform, silence at the ends, onset density and tempo,
 * a loopability score for ambience, and a simple vocals likelihood.
 */

export const ANALYSIS_VERSION = 1;
const SR = 16000;

export interface Loudness {
  lufs: number | null;
  truePeak: number | null;
}

function run(
  cmd: string,
  args: string[],
  wantStdout: boolean,
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', wantStdout ? 'pipe' : 'ignore', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    p.stdout?.on('data', (b: Buffer) => out.push(b));
    p.stderr?.on('data', (b: Buffer) => {
      err += b.toString();
      if (err.length > 200_000) err = err.slice(-100_000);
    });
    p.on('error', reject);
    p.on('close', (code) => resolve({ stdout: Buffer.concat(out), stderr: err, code: code ?? 1 }));
  });
}

export async function measureLoudness(file: string): Promise<Loudness> {
  const { stderr } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-nostats',
      '-nostdin',
      '-i',
      file,
      '-vn',
      '-af',
      'ebur128=peak=true',
      '-f',
      'null',
      '-',
    ],
    false,
  );
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
  const pk = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
  const num = (m: RegExpExecArray | null) => (m && m[1] !== '-inf' ? Number(m[1]) : null);
  return { lufs: num(i), truePeak: num(pk) };
}

export async function decodeMono16k(file: string, maxSeconds = 900): Promise<Float32Array> {
  const { stdout, code, stderr } = await run(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-i',
      file,
      '-vn',
      '-t',
      String(maxSeconds),
      '-ac',
      '1',
      '-ar',
      String(SR),
      '-f',
      'f32le',
      'pipe:1',
    ],
    true,
  );
  if (code !== 0) throw new Error(stderr.trim().split('\n').pop() || 'decode failed');
  const f = new Float32Array(Math.floor(stdout.byteLength / 4));
  new Uint8Array(f.buffer).set(stdout.subarray(0, f.length * 4));
  return f;
}

export interface Features {
  energy: number;
  waveform: Uint8Array;
  introSkipS: number | null;
  outroTrimS: number | null;
  onsetDensity: number;
  tempoBpm: number | null;
  loopScore: number;
  vocalsScore: number;
}

function windowRms(x: Float32Array, win: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0;
    for (let k = i; k < i + win; k++) s += x[k]! * x[k]!;
    out.push(Math.sqrt(s / win));
  }
  return out;
}

const db = (v: number) => (v > 0 ? 20 * Math.log10(v) : -120);

/** Pure feature extraction from mono 16 kHz audio (unit-tested). */
export function extractFeatures(x: Float32Array): Features {
  const secRms = windowRms(x, SR);
  const peakRms = Math.max(1e-9, ...secRms);
  // Energy: mean loudness of the track relative to −40 dBFS..−6 dBFS, 0–1.
  const meanDb = secRms.length ? secRms.reduce((a, v) => a + db(v), 0) / secRms.length : -120;
  const energy = Math.max(0, Math.min(1, (meanDb + 40) / 34));

  // Mini waveform: 200 peak bins scaled to 0–255.
  const bins = 200;
  const waveform = new Uint8Array(bins);
  const per = Math.max(1, Math.floor(x.length / bins));
  for (let b = 0; b < bins; b++) {
    let p = 0;
    for (let i = b * per; i < Math.min(x.length, (b + 1) * per); i++)
      p = Math.max(p, Math.abs(x[i]!));
    waveform[b] = Math.round(Math.min(1, p) * 255);
  }

  // Silence at the ends: 100 ms windows below −50 dBFS (or 30 dB below the loudest second).
  const fine = windowRms(x, SR / 10);
  const thr = Math.max(db(peakRms) - 30, -50);
  let lead = 0;
  while (lead < fine.length && db(fine[lead]!) < thr) lead++;
  let tail = 0;
  while (tail < fine.length - lead && db(fine[fine.length - 1 - tail]!) < thr) tail++;
  const introSkipS = lead / 10 >= 2 ? Math.round((lead / 10 - 0.5) * 10) / 10 : null;
  const outroTrimS = tail / 10 >= 2 ? Math.round((tail / 10 - 0.5) * 10) / 10 : null;

  // Onsets via spectral flux on 32 ms frames (512 samples, hop 256).
  const N = 512;
  const hop = 256;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  let prevMag: Float64Array | null = null;
  const flux: number[] = [];
  const speechBand: number[] = [];
  const total: number[] = [];
  for (let i = 0; i + N <= x.length; i += hop) {
    for (let k = 0; k < N; k++) {
      re[k] = x[i + k]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * k) / (N - 1)));
      im[k] = 0;
    }
    fft(re, im);
    const mag = new Float64Array(N / 2);
    let f = 0;
    let sb = 0;
    let tot = 0;
    for (let k = 1; k < N / 2; k++) {
      mag[k] = Math.hypot(re[k]!, im[k]!);
      if (prevMag) f += Math.max(0, mag[k]! - prevMag[k]!);
      const hz = (k * SR) / N;
      if (hz >= 300 && hz <= 3400) sb += mag[k]!;
      tot += mag[k]!;
    }
    flux.push(f);
    speechBand.push(sb);
    total.push(tot);
    prevMag = mag;
  }
  const fps = SR / hop;
  let onsets = 0;
  const meanFlux = flux.reduce((a, b) => a + b, 0) / Math.max(1, flux.length);
  for (let i = 1; i < flux.length - 1; i++) {
    if (flux[i]! > meanFlux * 1.8 && flux[i]! > flux[i - 1]! && flux[i]! >= flux[i + 1]!) onsets++;
  }
  const durationS = x.length / SR;
  const onsetDensity = durationS > 0 ? Math.round((onsets / durationS) * 100) / 100 : 0;

  // Tempo: autocorrelation of the flux envelope between 60 and 180 BPM.
  let tempoBpm: number | null = null;
  if (flux.length > fps * 8) {
    const env = flux.map((v) => v - meanFlux);
    let best = 0;
    let bestLag = 0;
    for (let bpm = 60; bpm <= 180; bpm++) {
      const lag = Math.round((60 / bpm) * fps);
      let s = 0;
      for (let i = 0; i + lag < env.length; i++) s += env[i]! * env[i + lag]!;
      if (s > best) {
        best = s;
        bestLag = lag;
      }
    }
    if (bestLag > 0) tempoBpm = Math.round((60 * fps) / bestLag);
  }

  // Loopability: similarity of the last and first 3 s (RMS envelope + level).
  let loopScore = 0;
  if (fine.length >= 60) {
    const a = fine.slice(0, 30);
    const b = fine.slice(-30);
    const ma = a.reduce((s, v) => s + v, 0) / 30;
    const mb = b.reduce((s, v) => s + v, 0) / 30;
    const level = 1 - Math.min(1, Math.abs(db(ma) - db(mb)) / 12);
    const varA = a.reduce((s, v) => s + (v - ma) ** 2, 0) / 30;
    const varB = b.reduce((s, v) => s + (v - mb) ** 2, 0) / 30;
    const steady =
      1 -
      Math.min(
        1,
        (Math.sqrt(varA) / Math.max(1e-6, ma) + Math.sqrt(varB) / Math.max(1e-6, mb)) / 2,
      );
    loopScore = Math.round(Math.max(0, level * 0.6 + steady * 0.4) * 100) / 100;
  }

  // Vocals likelihood: speech-band share of energy with syllable-rate (3–8 Hz) modulation.
  let vocalsScore = 0;
  if (speechBand.length > fps * 4) {
    const ratio = speechBand.map((v, i) => v / Math.max(1e-9, total[i]!));
    const meanRatio = ratio.reduce((a, b) => a + b, 0) / ratio.length;
    const envm = speechBand.reduce((a, b) => a + b, 0) / speechBand.length;
    const env = speechBand.map((v) => v - envm);
    let mod = 0;
    let base = 0;
    for (const lagS of [0.125, 0.167, 0.25, 0.333]) {
      const lag = Math.round(lagS * fps);
      let s = 0;
      for (let i = 0; i + lag < env.length; i++) s += env[i]! * env[i + lag]!;
      mod += s;
    }
    for (const v of env) base += v * v;
    const modulation = base > 0 ? Math.max(0, Math.min(1, mod / (4 * base))) : 0;
    vocalsScore =
      Math.round(
        Math.max(0, Math.min(1, (meanRatio - 0.35) * 2)) * (0.4 + 0.6 * modulation) * 100,
      ) / 100;
  }

  return {
    energy: Math.round(energy * 100) / 100,
    waveform,
    introSkipS,
    outroTrimS,
    onsetDensity,
    tempoBpm,
    loopScore,
    vocalsScore,
  };
}

/** Loudness offset for a kind (SPEC §6.3): music −18 LUFS, ambience −24 LUFS, SFX peak −3 dBFS. */
export function gainOffset(
  kind: string,
  l: Loudness,
  targets = { musicLufs: -18, ambienceLufs: -24, sfxPeakDb: -3 },
): number | null {
  let g: number | null = null;
  if (kind === 'sfx' || kind === 'sting') {
    if (l.truePeak != null) g = targets.sfxPeakDb - l.truePeak;
  } else if (l.lufs != null) {
    g = (kind === 'ambience' ? targets.ambienceLufs : targets.musicLufs) - l.lufs;
    // Never push a track's true peak past 0 dBFS (the limiter would work hard).
    if (l.truePeak != null) g = Math.min(g, -0.5 - l.truePeak);
  }
  return g == null ? null : Math.round(Math.max(-24, Math.min(12, g)) * 10) / 10;
}

export async function analyseTrack(repo: LibraryRepo, t: TrackRow): Promise<void> {
  const loud = await measureLoudness(t.path);
  const audio = await decodeMono16k(t.path);
  const f = extractFeatures(audio);
  repo.setAnalysis(
    t.id,
    {
      lufs: loud.lufs,
      true_peak: loud.truePeak,
      gain_db: gainOffset(t.kind, loud),
      energy: f.energy,
      tempo_bpm: f.tempoBpm,
      onset_density: f.onsetDensity,
      intro_skip_s: t.intro_skip_s ?? f.introSkipS,
      outro_trim_s: f.outroTrimS,
      loop_score: f.loopScore,
      vocals_score: f.vocalsScore,
      duration_s: t.duration_s ?? audio.length / SR,
    },
    ANALYSIS_VERSION,
  );
  repo.setWaveform(t.id, f.waveform);
  applyHeuristics(repo, t.id); // intensity, loopable and vocals guesses improve with features
}

let running = false;

/** Analyse every track that hasn't been analysed at the current version. Resumable. */
export async function analyseLibrary(
  repo: LibraryRepo,
  opts: {
    onProgress?: (p: {
      phase: 'analysing' | 'done' | 'error';
      progress: number;
      added: number;
      changed: number;
      removed: number;
      errors: number;
      message?: string;
    }) => void;
    limit?: number;
  } = {},
): Promise<{ analysed: number; errors: number }> {
  if (running) return { analysed: 0, errors: 0 };
  running = true;
  let analysed = 0;
  let errors = 0;
  try {
    const todo = repo
      .all()
      .filter(
        (t) => !t.missing && (t.analysed_at == null || t.analysis_version < ANALYSIS_VERSION),
      );
    const list = opts.limit ? todo.slice(0, opts.limit) : todo;
    for (const [i, t] of list.entries()) {
      try {
        await analyseTrack(repo, t);
        analysed++;
      } catch (err) {
        errors++;
        repo.markBad(t.id, (err as Error).message);
      }
      opts.onProgress?.({
        phase: 'analysing',
        progress: (i + 1) / list.length,
        added: 0,
        changed: analysed,
        removed: 0,
        errors,
      });
    }
    opts.onProgress?.({
      phase: 'done',
      progress: 1,
      added: 0,
      changed: analysed,
      removed: 0,
      errors,
      message: `Analysed ${analysed} file(s)`,
    });
  } finally {
    running = false;
  }
  return { analysed, errors };
}
