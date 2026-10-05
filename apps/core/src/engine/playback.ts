import fs from 'node:fs';
import path from 'node:path';
import type { Kind, NowPlaying } from '@cantina/shared';
import type { EventBus } from '../bus/bus.ts';
import type { TrackRow } from '../library/repo.ts';
import type { EndReason, Mixer, Voice, VoiceMeta } from '../mixer/mixer.ts';
import { BufferSource, FfmpegSource, SfxCache, type PcmSource } from '../mixer/sources.ts';
import type { Logger } from '../util/logger.ts';

/** What playback needs to know about a file. Built from a library row or an ad-hoc path. */
export interface PlayableTrack {
  id: string;
  path: string;
  title: string;
  album: string | null;
  durationS: number | null;
  kind: Kind;
  /** Loudness offset from analysis (SPEC §6.3). */
  gainDb: number;
  introSkipS: number;
}

export function toPlayable(t: TrackRow): PlayableTrack {
  return {
    id: t.id,
    path: t.path,
    title: t.title,
    album: t.album,
    durationS: t.duration_s,
    kind: t.kind,
    gainDb: t.gain_db ?? 0,
    introSkipS: t.intro_skip_s ?? 0,
  };
}

/** Resolve a path from config (relative to a library root, or absolute inside one). */
export function resolveLibraryPath(ref: string, roots: string[]): string | null {
  if (path.isAbsolute(ref)) {
    const inRoot = roots.some((r) => ref.startsWith(r + path.sep));
    return inRoot && fs.existsSync(ref) ? ref : null;
  }
  for (const r of roots) {
    const p = path.resolve(r, ref);
    if (!p.startsWith(r + path.sep)) continue; // no escaping the root
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function adHocTrack(absPath: string, kind: Kind = 'music'): PlayableTrack {
  return {
    id: `path:${absPath}`,
    path: absPath,
    title: path.basename(absPath, path.extname(absPath)),
    album: null,
    durationS: null,
    kind,
    gainDb: 0,
    introSkipS: 0,
  };
}

export interface PlaybackHooks {
  /** Music ended naturally or failed: the director picks what's next. */
  onMusicFinished?: (track: PlayableTrack, reason: EndReason) => void;
  /** A file could not be decoded (SPEC §14): mark it bad in the library. */
  onBadTrack?: (track: PlayableTrack, error: string) => void;
  onMusicStarted?: (track: PlayableTrack) => void;
  /** A trigger loop ended (e.g. the saber hum's safety stop). */
  onLoopEnded?: (stateKey: string, reason: EndReason) => void;
}

interface Playing {
  track: PlayableTrack;
  voice: Voice;
  startedAt: number;
}

/**
 * Turns tracks into mixer voices (SPEC §6): streaming decode for music and ambience, pre-decoded
 * buffers for SFX, loudness offsets, and lifecycle events.
 */
export class Playback {
  private readonly playing = new Map<string, Playing>(); // voice id → track
  readonly sfxCache: SfxCache;
  hooks: PlaybackHooks = {};

  constructor(
    private readonly mixer: Mixer,
    private readonly bus: EventBus,
    private readonly log: Logger,
    opts: { sfxCache?: SfxCache; now?: () => number } = {},
  ) {
    this.sfxCache = opts.sfxCache ?? new SfxCache();
    this.now = opts.now ?? Date.now;
    mixer.onVoiceEnd = (v, reason) => this.voiceEnded(v, reason);
  }

  private readonly now: () => number;

  get currentMusic(): (Playing & { positionS: number }) | null {
    const v = this.mixer.music;
    const p = v ? this.playing.get(v.id) : undefined;
    return p ? { ...p, positionS: v!.source.positionS } : null;
  }

  nowPlaying(): { music: NowPlaying | null; ambience: NowPlaying[] } {
    const view = (p: Playing): NowPlaying => ({
      trackId: p.track.id,
      title: p.track.title,
      album: p.track.album,
      durationS: p.track.durationS,
      positionS: Math.round(p.voice.source.positionS * 10) / 10,
    });
    const m = this.mixer.music;
    const music = m ? this.playing.get(m.id) : undefined;
    return {
      music: music ? view(music) : null,
      ambience: this.mixer
        .voices('ambience')
        .filter((v) => !v.stopping)
        .map((v) => this.playing.get(v.id))
        .filter((p): p is Playing => !!p)
        .map(view),
    };
  }

  ambienceTrackIds(): string[] {
    return this.mixer
      .voices('ambience')
      .filter((v) => !v.stopping)
      .map((v) => this.playing.get(v.id)?.track.id)
      .filter((x): x is string => !!x);
  }

  /** Start music. Waits for the pre-buffer so playback never starts on an underrun. */
  async playMusic(
    track: PlayableTrack,
    opts: { crossfadeS?: number; reason?: string; startS?: number } = {},
  ): Promise<boolean> {
    const source = new FfmpegSource(track.path, track.title, {
      startS: opts.startS ?? track.introSkipS,
      durationS: track.durationS,
    });
    await source.ready();
    if (source.error) {
      this.fail(track, source.error);
      return false;
    }
    const voice = this.mixer.playMusic(source, this.meta(track), {
      crossfadeS: opts.crossfadeS,
      gainDb: track.gainDb,
    });
    this.started(track, voice, 'music', opts.reason ?? 'manual');
    this.hooks.onMusicStarted?.(track);
    return true;
  }

  async addAmbience(track: PlayableTrack, opts: { fadeInS?: number } = {}): Promise<boolean> {
    if (this.ambienceTrackIds().includes(track.id)) return true;
    const source = new FfmpegSource(track.path, track.title, { loop: true, durationS: null });
    await source.ready();
    if (source.error) {
      this.fail(track, source.error);
      return false;
    }
    const voice = this.mixer.addAmbience(source, this.meta(track), {
      fadeInS: opts.fadeInS ?? 3,
      gainDb: track.gainDb,
    });
    this.started(track, voice, 'ambience', 'scene');
    return true;
  }

  stopAmbience(trackId: string, fadeS = 3): void {
    for (const v of this.mixer.voices('ambience')) {
      if (this.playing.get(v.id)?.track.id === trackId) this.mixer.stopVoice(v.id, fadeS);
    }
  }

  /** Fire an SFX from a pre-decoded buffer (SPEC §21: lowest latency). */
  async fireSfx(
    track: PlayableTrack,
    meta: Partial<VoiceMeta> = {},
    opts: { gainDb?: number; loop?: boolean; maxSeconds?: number; sting?: boolean } = {},
  ): Promise<string | null> {
    let data: Float32Array;
    try {
      data = await this.sfxCache.get(track.path);
    } catch (err) {
      this.fail(track, (err as Error).message);
      return null;
    }
    const src: PcmSource = new BufferSource(data, track.title, {
      loop: opts.loop,
      loopCrossfadeS: 0.03,
    });
    const voice = this.mixer.playSfx(
      src,
      { ...this.meta(track), ...meta, sting: opts.sting },
      {
        gainDb: track.gainDb + (opts.gainDb ?? 0),
        maxSeconds: opts.maxSeconds,
      },
    );
    this.playing.set(voice.id, { track, voice, startedAt: this.now() });
    this.bus.emit('sfx.fired', {
      sfxId: track.id,
      title: track.title,
      userId: meta.userId ?? null,
      triggerId: meta.triggerId ?? null,
      subject: meta.subject ?? null,
    });
    return voice.id;
  }

  /** Pre-decode SFX so the first trigger is as fast as the rest. */
  async warm(tracks: PlayableTrack[]): Promise<void> {
    for (const t of tracks) {
      try {
        await this.sfxCache.get(t.path);
      } catch {
        // reported when fired
      }
    }
  }

  /** Stop SFX loops started for a state key (e.g. `james.saber`). */
  stopLoops(stateKey: string, fadeS = 0.4): number {
    let n = 0;
    for (const v of this.mixer.voices('sfx')) {
      if (v.meta.stateKey === stateKey && !v.stopping) {
        this.mixer.stopVoice(v.id, fadeS);
        n++;
      }
    }
    return n;
  }

  private meta(track: PlayableTrack): VoiceMeta {
    return { trackId: track.id, title: track.title, album: track.album };
  }

  private started(
    track: PlayableTrack,
    voice: Voice,
    layer: 'music' | 'ambience',
    reason: string,
  ): void {
    this.playing.set(voice.id, { track, voice, startedAt: this.now() });
    this.bus.emit('track.started', {
      layer,
      trackId: track.id,
      title: track.title,
      album: track.album,
      durationS: track.durationS,
      reason,
    });
    this.log.info({ layer, trackId: track.id, reason }, 'track started');
  }

  private fail(track: PlayableTrack, error: string): void {
    this.log.warn({ trackId: track.id, error }, 'track failed to decode');
    this.bus.emit('log.error', {
      source: 'playback',
      message: `Could not play "${track.title}": ${error}`,
    });
    this.hooks.onBadTrack?.(track, error);
  }

  private voiceEnded(v: Voice, reason: EndReason): void {
    const p = this.playing.get(v.id);
    this.playing.delete(v.id);
    if (v.meta.stateKey) this.hooks.onLoopEnded?.(v.meta.stateKey, reason);
    if (!p || v.layer === 'sfx') return;
    this.bus.emit('track.ended', { layer: v.layer, trackId: p.track.id, reason });
    if (reason === 'error') this.fail(p.track, v.source.error ?? 'decode error');
    if (v.layer === 'music' && (reason === 'ended' || reason === 'error')) {
      this.hooks.onMusicFinished?.(p.track, reason);
    }
  }
}
