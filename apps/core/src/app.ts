import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  EPHEMERAL_EVENTS,
  HealthComponent,
  LAYERS,
  PERSISTED_EVENTS,
  type EarsResult,
  type HealthStatus,
  type Layer,
  type Mode,
  type PlayerView,
  type SfxButton,
  type SoundRef,
  type StateSnapshot,
} from '@cantina/shared';
import { DiscordAdapter } from './adapters/discord/adapter.ts';
import type { CommandActions } from './adapters/discord/commands.ts';
import { isGm as isGmCheck } from './adapters/discord/presence.ts';
import { Downsampler48to16 } from './adapters/ears/resample.ts';
import { EarsSupervisor } from './adapters/ears/supervisor.ts';
import { TranscriptBuffer } from './adapters/ears/transcripts.ts';
import { EventBus } from './bus/bus.ts';
import { ConfigStore, type ConfigValues } from './config/store.ts';
import { Director } from './engine/director.ts';
import { MtfbwyHooks } from './engine/hooks/mtfbwy.ts';
import {
  adHocTrack,
  Playback,
  resolveLibraryPath,
  toPlayable,
  type PlayableTrack,
} from './engine/playback.ts';
import { TriggerEngine, type FireRequest } from './engine/triggers/engine.ts';
import type { Env } from './env.ts';
import { writeBackup } from './library/backup.ts';
import { openDatabase } from './library/db.ts';
import { LibraryRepo, type TrackRow } from './library/repo.ts';
import { scanLibrary, scanOne } from './library/scanner.ts';
import { MixClock } from './mixer/clock.ts';
import { Mixer } from './mixer/mixer.ts';
import { LocalSpeakersSink } from './mixer/outputs/local-speakers.ts';
import { CONFIG_DIR, dataDir } from './paths.ts';
import { createLogger, type Logger } from './util/logger.ts';
import type { Rng } from './util/random.ts';

export const VERSION = '0.1.0';

export interface AppOptions {
  env: Env;
  configDir?: string;
  dbFile?: string;
  log?: Logger;
  discord?: boolean;
  ears?: boolean;
  /** Don't start the real-time mixer clock (tests render frames manually). */
  clock?: boolean;
  watchLibrary?: boolean;
  rng?: Rng;
}

const SOUNDBOARD_KEYS = 'QWERTYUIOPASDFGHJKL;'.split('');

/**
 * Cantina: composes config, library, mixer, playback, director, triggers, hooks, ears and Discord,
 * and exposes the actions used by slash commands, the REST API and the simulator.
 */
export class Cantina implements CommandActions {
  readonly bus = new EventBus();
  readonly config: ConfigStore;
  readonly log: Logger;
  readonly repo: LibraryRepo;
  readonly mixer: Mixer;
  readonly clock: MixClock;
  readonly playback: Playback;
  readonly director: Director;
  readonly triggers: TriggerEngine;
  readonly hooks: MtfbwyHooks;
  readonly transcripts: TranscriptBuffer;
  discord: DiscordAdapter | null = null;
  ears: EarsSupervisor | null = null;
  private localSpeakers: LocalSpeakersSink | null = null;
  private readonly startedAt = Date.now();
  private health = new Map<HealthComponent, { status: HealthStatus; message: string }>();
  private speaking = new Set<string>();
  private listening = true;
  private excluded = new Set<string>();
  private downsamplers = new Map<string, Downsampler48to16>();
  private timers: NodeJS.Timeout[] = [];
  private watcher: FSWatcher | null = null;
  private caffeinate: ChildProcess | null = null;
  private sfxHistory: string[] = [];
  private swellTimer: NodeJS.Timeout | null = null;

  constructor(readonly opts: AppOptions) {
    this.log = opts.log ?? createLogger(opts.env.CANTINA_LOG_LEVEL);
    this.config = new ConfigStore(opts.configDir ?? CONFIG_DIR);
    const cfg = this.config.loadAll();
    const s = cfg.settings;
    for (const c of HealthComponent.options) this.health.set(c, { status: 'ok', message: '' });
    this.health.set('discord', { status: 'down', message: 'Not started' });
    this.health.set('voice', { status: 'ok', message: 'Not in voice' });
    this.health.set('ears', { status: 'down', message: 'Not started' });

    const dir = dataDir(opts.env);
    this.repo = new LibraryRepo(
      openDatabase(opts.dbFile ?? path.join(dir, 'cantina.db'), {
        backup: () => this.log.info('migrating database: backup written first'),
      }),
    );

    this.mixer = new Mixer({
      master: s.mixer.master,
      layers: s.mixer.layers,
      ceilingDb: s.mixer.limiter.ceilingDb,
      lookaheadMs: s.mixer.limiter.lookaheadMs,
      ducking: s.mixer.ducking,
    });
    this.mixer.defaultCrossfadeS = s.mixer.defaultCrossfadeS;
    this.clock = new MixClock(() => this.mixer.renderFrame());
    this.playback = new Playback(this.mixer, this.bus, this.log);
    this.transcripts = new TranscriptBuffer(s.ears.retentionMinutes);
    this.listening = s.ears.enabled;

    this.triggers = new TriggerEngine(
      {
        bus: this.bus,
        now: () => Date.now(),
        fire: (req) => this.fireTrigger(req),
        stopLoops: (k) => this.playback.stopLoops(k),
        nudgeScene: (scene, pts, why) => this.director.nudge(scene, pts, why),
        onEvent: (key) => this.director.onEvent(key),
      },
      cfg.triggers,
      cfg.players.players,
      s.triggers,
    );
    this.director = new Director({
      repo: this.repo,
      playback: this.playback,
      bus: this.bus,
      log: this.log,
      scenes: () => this.config.get('scenes').scenes,
      settings: () => this.config.get('settings'),
      roots: () => this.opts.env.libraryRoots,
      rng: opts.rng ?? Math.random,
      synonyms: this.triggers.synonyms,
    });
    this.playback.hooks.onLoopEnded = (key) => this.triggers.loopEnded(key);
    this.hooks = new MtfbwyHooks(
      cfg.hooks,
      {
        bus: this.bus,
        now: () => Date.now(),
        playSting: (ref, why) => void this.playSting(ref, why),
        setTension: (step) => this.director.setTension(step),
        nudgeScene: (scene, pts, why) => this.director.nudge(scene, pts, why),
        currentScene: () => this.director.current,
        swellAmbience: () => this.swellAmbience(),
      },
      this.triggers.synonyms,
    );

    this.wireBus();
    this.config.onChange((name, value) => this.onConfigChange(name, value));
  }

  /* ------------------------------ lifecycle ------------------------------ */

  async start(): Promise<void> {
    const s = this.settings;
    this.config.watch((err) => {
      this.log.warn(err.message);
      this.bus.emit('log.error', { source: 'config', message: err.message });
    });
    if (this.opts.clock !== false) this.clock.start();
    if (s.outputs.localSpeakers) this.setLocalSpeakers(true);
    this.timers.push(
      setInterval(() => this.director.tick(), 250),
      setInterval(() => this.hooks.tick(), 5000),
      setInterval(() => this.emitMixerState(), 100),
      setInterval(() => this.repo.pruneEvents(), 3_600_000),
    );
    this.timers.push(setInterval(() => this.checkRoots(), s.library.recheckS * 1000));
    void this.rescan();
    if (this.opts.watchLibrary !== false) this.watchLibrary();
    if (this.opts.ears !== false && s.ears.enabled && s.inputs.discordVoice) this.startEars();
    else
      this.setHealth('ears', 'degraded', 'Speech recognition off: manual and text triggers only');
    if (this.opts.discord !== false) await this.startDiscord();
    // Pre-decode personal SFX so the first trigger is as quick as the rest.
    void this.playback.warm(this.personalSfxTracks());
  }

  private async startDiscord(): Promise<void> {
    const env = this.opts.env;
    if (!env.DISCORD_TOKEN || !env.DISCORD_GUILD_ID) {
      this.setHealth(
        'discord',
        'down',
        'DISCORD_TOKEN / DISCORD_GUILD_ID not set (docs/SETUP-DISCORD.md)',
      );
      return;
    }
    this.discord = new DiscordAdapter({
      token: env.DISCORD_TOKEN,
      guildId: env.DISCORD_GUILD_ID,
      bus: this.bus,
      log: this.log,
      settings: () => this.settings,
      actions: this,
      attachSink: (sink) => this.settings.outputs.discord && this.clock.addSink(sink),
      detachSink: (sink) => this.clock.removeSink(sink),
      isListenedTo: (userId) => this.isListenedTo(userId),
      onUserAudio: (userId, pcm) => this.onUserAudio(userId, pcm),
      onUserAudioEnd: (userId) => this.ears?.endUtterance(userId),
      onTextMessage: (m) => void this.onTextMessage(m),
      beforeLeave: async () => {
        this.mixer.panic(1);
        await new Promise((r) => setTimeout(r, 1100));
      },
    });
    try {
      await this.discord.start();
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'discord failed to start');
    }
  }

  private startEars(): void {
    const s = this.settings;
    this.ears = new EarsSupervisor({
      port: this.opts.env.CANTINA_EARS_PORT,
      bus: this.bus,
      log: this.log,
      silenceMs: s.ears.silenceMs,
      whisperModel: s.ears.whisperModel,
      voskModel: s.ears.voskModel,
      heartbeatTimeoutS: s.ears.heartbeatTimeoutS,
      modelsDir: path.join(dataDir(this.opts.env), 'models'),
      onResult: (r) => void this.onEarsResult(r),
      configure: () => this.earsConfig(),
    });
    this.ears.start();
  }

  earsConfig(): { grammar: string[]; initialPrompt: string } {
    const v = this.config.get('vocabulary');
    const scenes = this.config.get('scenes').scenes;
    const words = new Set<string>(this.triggers.vocabulary());
    for (const sc of scenes) {
      for (const kw of [
        ...Object.keys(sc.entry.keywords),
        ...Object.keys(sc.exit?.keywords ?? {}),
      ]) {
        for (const w of kw.toLowerCase().split(/[^a-z0-9']+/))
          if (w) words.add(w.replace(/'/g, ''));
      }
    }
    for (const t of [...v.terms, ...v.places, ...v.characters])
      for (const w of t.toLowerCase().split(/\s+/)) words.add(w);
    for (const p of this.config.get('hooks').phrases)
      for (const ph of p.phrases)
        for (const w of ph.toLowerCase().split(/[^a-z0-9]+/)) if (w) words.add(w);
    const players = this.config.get('players').players;
    const terms = [
      ...v.characters,
      ...players.flatMap((p) => [p.character ?? '', ...p.aliases]).filter(Boolean),
      ...v.places,
      ...v.terms,
    ];
    return {
      grammar: [...words].filter((w) => !/^(number|character|player)$/.test(w)),
      initialPrompt: `A tabletop role-playing game set in a galaxy far away. Names and terms: ${[...new Set(terms)].join(', ')}.`,
    };
  }

  /** Graceful shutdown (SPEC §14): fade out, leave voice, flush, back up. */
  async shutdown(): Promise<void> {
    this.log.info('shutting down');
    this.mixer.panic(1);
    await new Promise((r) => setTimeout(r, this.clock.running ? 1100 : 0));
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.discord?.leave(false).catch(() => undefined);
    await this.discord?.destroy().catch(() => undefined);
    this.ears?.stop();
    this.clock.stop();
    this.localSpeakers?.close();
    this.stopCaffeinate();
    await this.watcher?.close();
    this.config.close();
    try {
      if (this.repo.count() > 0)
        writeBackup(this.repo, path.join(dataDir(this.opts.env), 'backups'), 'session');
    } catch (err) {
      this.log.warn({ err: (err as Error).message }, 'backup failed');
    }
    this.repo.db.close();
  }

  get settings(): ConfigValues['settings'] {
    return this.config.get('settings');
  }

  /* ------------------------------- bus wiring ------------------------------- */

  private wireBus(): void {
    this.bus.on('system.health', (p) =>
      this.health.set(p.component, { status: p.status, message: p.message }),
    );
    this.bus.on('voice.speaking', ({ userId, speaking }) => {
      if (speaking) this.speaking.add(userId);
      else this.speaking.delete(userId);
      this.updateDucking();
    });
    this.bus.on('voice.connection', ({ state }) => {
      if (state === 'ready') {
        this.startCaffeinate();
        if (!this.director.current) {
          const first = this.config.get('scenes').scenes.find((s) => !s.manualOnly);
          if (first) void this.director.setScene(first.id, 'manual').catch(() => undefined);
        }
        if (this.listening && this.settings.ears.enabled) void this.announceListening();
      }
      if (state === 'disconnected') this.stopCaffeinate();
    });
    this.bus.on('sfx.fired', () => this.triggers.noteSfx());
    this.bus.on('scene.changed', ({ to }) => {
      // A manual scene change in combat resets the Focus to the heroes when leaving combat.
      if (!['combat', 'boss', 'chase'].includes(to) && this.hooks.state().focus === 'gm')
        this.hooks.setFocus('heroes');
    });
    this.bus.onAny((e) => {
      if (PERSISTED_EVENTS.has(e.type)) {
        try {
          this.repo.logEvent(e.ts, e.type, e.payload);
        } catch {
          // the event log is best effort
        }
      }
      if (!EPHEMERAL_EVENTS.has(e.type) && e.type !== 'system.health')
        this.log.debug({ type: e.type }, 'event');
    });
  }

  private onConfigChange(name: string, _value: unknown): void {
    const cfg = this.config.all();
    if (name === 'triggers' || name === 'players' || name === 'settings') {
      this.triggers.update(cfg.triggers, cfg.players.players, cfg.settings.triggers);
      this.director.reconfigure(this.triggers.synonyms);
      this.hooks.update(cfg.hooks, this.triggers.synonyms);
      this.ears?.reconfigure();
      void this.playback.warm(this.personalSfxTracks());
    }
    if (name === 'scenes') this.director.reconfigure(this.triggers.synonyms);
    if (name === 'hooks') this.hooks.update(cfg.hooks, this.triggers.synonyms);
    if (name === 'vocabulary') this.ears?.reconfigure();
    if (name === 'settings') {
      const s = cfg.settings;
      this.transcripts.setRetention(s.ears.retentionMinutes);
      this.mixer.setDucking(s.mixer.ducking);
      this.mixer.defaultCrossfadeS = s.mixer.defaultCrossfadeS;
      this.setLocalSpeakers(s.outputs.localSpeakers);
    }
    this.log.info({ name }, 'config reloaded');
  }

  private setHealth(component: HealthComponent, status: HealthStatus, message: string): void {
    this.bus.emit('system.health', { component, status, message });
  }

  /* ------------------------------- listening ------------------------------- */

  /** Opted-out or globally-off users are never sent to ears (SPEC §7.2.3). */
  isListenedTo(userId: string): boolean {
    return (
      this.listening &&
      this.settings.ears.enabled &&
      !this.excluded.has(userId) &&
      !!this.ears?.connected
    );
  }

  private onUserAudio(userId: string, pcm48: Buffer): void {
    if (!this.isListenedTo(userId)) return;
    let d = this.downsamplers.get(userId);
    if (!d) this.downsamplers.set(userId, (d = new Downsampler48to16()));
    this.ears?.sendAudio(userId, d.process(pcm48));
  }

  private updateDucking(): void {
    let active = false;
    for (const u of this.speaking) if (!this.excluded.has(u)) active = true;
    this.mixer.setSpeechActive(active);
  }

  setListening(enabled: boolean): void {
    this.listening = enabled;
    if (!enabled) this.downsamplers.clear();
    this.emitListening();
    void this.discord?.setListeningIndicator(enabled && this.settings.ears.enabled);
    if (enabled) void this.announceListening();
  }

  setUserListening(userId: string, enabled: boolean): void {
    if (enabled) this.excluded.delete(userId);
    else {
      this.excluded.add(userId);
      this.downsamplers.delete(userId);
      this.ears?.dropUser(userId);
    }
    this.updateDucking();
    this.emitListening();
  }

  private emitListening(): void {
    this.bus.emit('listening.state', {
      enabled: this.listening,
      excludedUserIds: [...this.excluded],
    });
  }

  private announced = false;
  private async announceListening(): Promise<void> {
    if (this.announced || !this.discord) return;
    this.announced = true;
    await this.discord.announce(
      '🎙 Cantina is listening for cues. Audio is processed locally and never stored. Use `/listen me off` to opt out.',
    );
    await this.discord.setListeningIndicator(true);
  }

  /* ----------------------------- utterances ----------------------------- */

  private isGmUser(userId: string | null): boolean {
    if (!userId) return false;
    const d = this.settings.discord;
    const p = this.triggers.playerByUser(userId);
    if (p?.role === 'gm') return true;
    return userId === d.gmUserId || d.gmUserIds.includes(userId);
  }

  private async onEarsResult(r: EarsResult): Promise<void> {
    if (this.excluded.has(r.userId)) return; // opted out after audio was already queued
    await this.handleUtterance({
      text: r.text,
      userId: r.userId,
      utteranceId: r.utteranceId,
      confidence: r.confidence,
      final: r.type === 'final',
      source: 'voice',
      speechEndedAt: r.latencyMs != null ? Date.now() - r.latencyMs : null,
    });
  }

  /** The single path every utterance takes: voice, text chat, simulator and local mic. */
  async handleUtterance(u: {
    text: string;
    userId: string | null;
    utteranceId: string;
    confidence: number;
    final: boolean;
    source: 'voice' | 'text' | 'sim' | 'mic';
    speechEndedAt?: number | null;
  }): Promise<void> {
    const text = u.text.trim();
    if (!text) return;
    const uid = u.userId ?? 'table';
    if (u.source !== 'text') {
      this.transcripts.add({ utteranceId: u.utteranceId, userId: uid, text, final: u.final });
      this.bus.emit(u.final ? 'transcript.final' : 'transcript.partial', {
        utteranceId: u.utteranceId,
        userId: uid,
        text,
        confidence: u.confidence,
        words: [],
      });
    }
    await this.triggers.process({
      text,
      userId: u.userId,
      utteranceId: u.utteranceId,
      confidence: u.confidence,
      kind: u.final ? 'final' : 'partial',
      source: u.source,
      speechEndedAt: u.speechEndedAt,
    });
    if (u.final) {
      const gm = this.isGmUser(u.userId);
      this.director.onText(text, gm);
      this.hooks.onText(text, gm);
    }
  }

  private async onTextMessage(m: {
    channelId: string;
    authorId: string;
    authorIsBot: boolean;
    content: string;
  }): Promise<void> {
    const s = this.settings;
    if (m.authorIsBot) {
      if (
        s.discord.diceBot.enabled &&
        (!s.discord.diceBot.userId || s.discord.diceBot.userId === m.authorId)
      ) {
        this.hooks.onDiceBotMessage(m.content, null);
      }
      return;
    }
    if (!s.inputs.discordText) return;
    const channels = s.discord.textTriggerChannelIds.length ? s.discord.textTriggerChannelIds : [];
    if (!channels.includes(m.channelId)) return;
    await this.handleUtterance({
      text: m.content,
      userId: m.authorId,
      utteranceId: `msg-${m.channelId}-${Date.now()}`,
      confidence: 1,
      final: true,
      source: 'text',
    });
  }

  /** Simulator (SPEC §7.1): inject a typed line as any player. */
  async simulate(playerId: string, text: string, final = true): Promise<void> {
    const p = this.config.get('players').players.find((x) => x.id === playerId);
    const userId = p?.discordUserId ?? playerId;
    await this.handleUtterance({
      text,
      userId,
      utteranceId: `sim-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      confidence: 1,
      final,
      source: 'sim',
      speechEndedAt: Date.now(),
    });
  }

  /* ------------------------------- sounds ------------------------------- */

  private trackFromPath(
    rel: string,
    kind: 'sfx' | 'music' | 'ambience' | 'sting' = 'sfx',
  ): PlayableTrack | null {
    const abs = resolveLibraryPath(rel, this.opts.env.libraryRoots);
    if (!abs) return null;
    const row = this.repo.getByPath(abs);
    return row ? toPlayable(row) : adHocTrack(abs, kind);
  }

  /** Resolve a sound reference to a track, avoiding the last 3 picks for a query (SPEC §9.4). */
  resolveSound(ref: SoundRef | null, kinds: string[] = ['sfx']): PlayableTrack | null {
    if (!ref) return null;
    if (typeof ref === 'string') return this.trackFromPath(ref);
    let rows: TrackRow[] = [];
    for (const kind of ref.kind ? [ref.kind] : kinds) {
      rows = this.repo.findSfx({ ...ref, kind });
      if (rows.length) break;
    }
    if (!rows.length) return null;
    const fresh = rows.filter((r) => !this.sfxHistory.slice(0, 3).includes(r.id));
    const pool = fresh.length ? fresh : rows;
    const pick = pool[Math.floor(Math.random() * pool.length)]!;
    this.sfxHistory.unshift(pick.id);
    this.sfxHistory.length = Math.min(this.sfxHistory.length, 10);
    return toPlayable(pick);
  }

  private async fireTrigger(req: FireRequest): Promise<boolean> {
    const t = req.trigger;
    const isSting = !!t.sting && !t.sound;
    const track =
      (req.overridePath && this.trackFromPath(req.overridePath)) ||
      this.resolveSound(req.sound, isSting ? ['sting', 'sfx'] : ['sfx']);
    const meta = { userId: req.userId, triggerId: t.id, subject: req.subject };
    let ok = false;
    if (track) {
      ok =
        (await this.playback.fireSfx(track, meta, { gainDb: t.gainDb, sting: isSting })) !== null;
    } else {
      this.bus.emit('log.error', {
        source: 'triggers',
        message: `No sound found for trigger ${t.id}`,
      });
    }
    if (req.loop) {
      const loopTrack =
        (req.loop.overridePath && this.trackFromPath(req.loop.overridePath)) ||
        this.resolveSound(req.loop.sound);
      if (loopTrack) {
        this.playback.stopLoops(req.loop.stateKey, 0.1);
        await this.playback.fireSfx(
          loopTrack,
          { ...meta, stateKey: req.loop.stateKey },
          { gainDb: req.loop.gainDb, loop: true, maxSeconds: req.loop.maxSeconds },
        );
      }
    }
    return ok;
  }

  private async playSting(ref: SoundRef, reason: string): Promise<void> {
    const track = this.resolveSound(ref, ['sting', 'sfx']);
    if (!track) {
      this.bus.emit('library.gap', { sceneId: 'stings', message: `No sting for ${reason}` });
      return;
    }
    await this.playback.fireSfx(track, { triggerId: null }, { sting: true });
  }

  private swellAmbience(): void {
    const base = this.mixer.snapshot().layers.ambience.gain;
    if (this.swellTimer) return;
    this.mixer.setLayerGain('ambience', Math.min(100, base + 15));
    this.swellTimer = setTimeout(() => {
      this.swellTimer = null;
      this.mixer.setLayerGain('ambience', base);
    }, 4000);
  }

  private personalSfxTracks(): PlayableTrack[] {
    const out: PlayableTrack[] = [];
    for (const p of this.config.get('players').players) {
      for (const rel of Object.values(p.sfx)) {
        const t = this.trackFromPath(rel);
        if (t) out.push(t);
      }
    }
    return out;
  }

  soundboard(): SfxButton[] {
    const buttons: SfxButton[] = [];
    const players = this.config.get('players').players;
    for (const t of this.config.get('triggers').triggers) {
      if (!t.enabled || (!t.sound && !t.sting)) continue;
      buttons.push({
        id: `trigger:${t.id}`,
        label: t.label ?? t.id,
        category: typeof t.sound === 'object' ? (t.sound.category ?? null) : null,
        playerId: null,
        character: null,
        triggerId: t.id,
        hotkey: null,
      });
      for (const p of players) {
        if (p.sfx[t.id]) {
          buttons.push({
            id: `player:${p.id}:${t.id}`,
            label: `${t.label ?? t.id}`,
            category: typeof t.sound === 'object' ? (t.sound.category ?? null) : null,
            playerId: p.id,
            character: p.character ?? p.displayName,
            triggerId: t.id,
            hotkey: null,
          });
        }
      }
    }
    const sfx = this.repo.list({ kind: 'sfx', limit: 80 }).rows;
    for (const r of sfx) {
      const cat =
        this.repo.tags(r.id).find((t) => t.facet === 'category' && t.status !== 'rejected')
          ?.value ?? null;
      buttons.push({
        id: r.id,
        label: r.title,
        category: cat,
        playerId: null,
        character: null,
        triggerId: null,
        hotkey: null,
      });
    }
    return buttons.map((b, i) => ({ ...b, hotkey: SOUNDBOARD_KEYS[i] ?? null }));
  }

  /* --------------------------- library upkeep --------------------------- */

  private scanPromise: Promise<void> | null = null;

  /** Scan the library; concurrent callers share the scan in flight. */
  rescan(): Promise<void> {
    this.scanPromise ??= this.doRescan().finally(() => (this.scanPromise = null));
    return this.scanPromise;
  }

  private async doRescan(): Promise<void> {
    const roots = this.opts.env.libraryRoots;
    if (!roots.length) {
      this.setHealth('library', 'degraded', 'No library roots: set CANTINA_LIBRARY_PATHS in .env');
      return;
    }
    try {
      const res = await scanLibrary(this.repo, roots, (p) => this.bus.emit('library.scan', p));
      const total = this.repo.count();
      this.setHealth(
        'library',
        res.message ? 'degraded' : 'ok',
        res.message ??
          `${total} files (${res.added} new, ${res.changed} changed, ${res.removed} missing)`,
      );
    } catch (err) {
      this.setHealth('library', 'degraded', `Scan failed: ${(err as Error).message}`);
    }
  }

  private watchLibrary(): void {
    const roots = this.opts.env.libraryRoots;
    if (!roots.length) return;
    // Read-only watch: Cantina never writes to library roots (SPEC §8.1).
    this.watcher = chokidar.watch(roots, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1500 },
      depth: 12,
    });
    const onFile = (f: string) => void scanOne(this.repo, f, roots).catch(() => undefined);
    this.watcher.on('add', onFile).on('change', onFile).on('unlink', onFile);
  }

  private rootsAvailable = new Set<string>();
  private checkRoots(): void {
    for (const r of this.opts.env.libraryRoots) {
      let ok: boolean;
      try {
        ok = fs.statSync(r).isDirectory();
      } catch {
        ok = false;
      }
      const was = this.rootsAvailable.has(r);
      if (ok && !was) {
        this.rootsAvailable.add(r);
        void this.rescan();
      } else if (!ok && was) {
        this.rootsAvailable.delete(r);
        this.setHealth('library', 'degraded', `Library root unavailable: ${r}`);
      }
    }
  }

  /* ----------------------------- outputs etc ----------------------------- */

  setLocalSpeakers(on: boolean): void {
    if (on && !this.localSpeakers) {
      this.localSpeakers = new LocalSpeakersSink();
      if (this.localSpeakers.error) {
        this.bus.emit('log.error', { source: 'mixer', message: this.localSpeakers.error });
        this.localSpeakers = null;
        return;
      }
      this.clock.addSink(this.localSpeakers);
    } else if (!on && this.localSpeakers) {
      this.clock.removeSink(this.localSpeakers);
      this.localSpeakers.close();
      this.localSpeakers = null;
    }
  }

  private startCaffeinate(): void {
    if (process.platform !== 'darwin' || this.caffeinate) return;
    this.caffeinate = spawn('caffeinate', ['-dimsu', '-w', String(process.pid)], {
      stdio: 'ignore',
    });
    this.caffeinate.on('exit', () => (this.caffeinate = null));
  }

  private stopCaffeinate(): void {
    this.caffeinate?.kill();
    this.caffeinate = null;
  }

  private emitMixerState(): void {
    const m = this.mixer.snapshot();
    this.bus.emit('mixer.state', {
      master: m.master,
      layers: m.layers,
      masterLevel: m.masterLevel,
      limiting: m.limiting,
      spectrum: m.spectrum,
    });
  }

  /* ---------------------------- CommandActions ---------------------------- */

  isGm(userId: string, roleIds: string[]): boolean {
    if (this.triggers.playerByUser(userId)?.role === 'gm') return true;
    return isGmCheck(userId, roleIds, this.settings.discord);
  }

  sfxAllowed(userId: string, sfxId: string, gm: boolean): boolean {
    if (gm) return true;
    if (this.settings.discord.sfxCommand === 'gm') return false;
    if (!sfxId.startsWith('player:')) return true; // generic SFX (Q10)
    const owner = sfxId.split(':')[1];
    return this.triggers.playerByUser(userId)?.id === owner;
  }

  async joinUserChannel(userId: string): Promise<string> {
    const ch = this.discord?.userVoiceChannel(userId);
    if (!ch) throw new Error('Join a voice channel first.');
    await this.join(ch);
    return 'Joining your channel.';
  }

  async join(channelId: string): Promise<void> {
    if (!this.discord) throw new Error('Discord is not connected');
    await this.discord.join(channelId);
  }

  async leave(): Promise<void> {
    this.mixer.panic(1);
    await new Promise((r) => setTimeout(r, this.clock.running ? 1000 : 0));
    await this.discord?.leave(true);
  }

  async setScene(sceneId: string): Promise<string> {
    const scene =
      this.director.scene(sceneId) ??
      this.config.get('scenes').scenes.find((s) => s.label.toLowerCase() === sceneId.toLowerCase());
    if (!scene) throw new Error(`No scene called "${sceneId}"`);
    await this.director.setScene(scene.id, 'manual');
    return `Scene: ${scene.label}.`;
  }

  async playTrack(trackId: string): Promise<string> {
    const t = await this.director.playTrack(trackId);
    return `Playing "${t.title}".`;
  }

  async fireSfx(sfxId: string, userId: string | null, subject?: string): Promise<string> {
    if (sfxId.startsWith('trigger:') || sfxId.startsWith('player:')) {
      const parts = sfxId.split(':');
      const triggerId = parts[parts.length - 1]!;
      const t = this.config.get('triggers').triggers.find((x) => x.id === triggerId);
      if (!t) throw new Error('Unknown sound');
      const subj =
        parts[0] === 'player'
          ? parts[1]!
          : (subject ?? this.triggers.playerByUser(userId)?.id ?? null);
      const player = subj
        ? this.config.get('players').players.find((p) => p.id === subj)
        : undefined;
      const ok = await this.fireTrigger({
        trigger: { ...t, loop: undefined },
        subject: subj,
        speaker: this.triggers.playerByUser(userId),
        sound: t.sound ?? t.sting ?? null,
        overridePath: player?.sfx[t.id] ?? null,
        loop: null,
        userId,
      });
      if (!ok) throw new Error('No sound file found for that');
      return `Fired ${t.label ?? t.id}.`;
    }
    const row = this.repo.get(sfxId);
    if (!row) throw new Error('Unknown sound');
    await this.playback.fireSfx(toPlayable(row), { userId });
    return `Fired ${row.title}.`;
  }

  stop(layer?: Layer): void {
    if (layer) this.mixer.stopLayer(layer, 1.5);
    else for (const l of LAYERS) this.mixer.stopLayer(l, 1.5);
  }

  setVolume(layer: Layer, value: number): void {
    this.mixer.setLayerGain(layer, value);
  }

  setMode(mode: Mode): void {
    this.director.setMode(mode);
  }

  setLocked(locked: boolean): void {
    this.director.setLocked(locked);
  }

  panic(): void {
    this.mixer.panic(1);
    this.triggers.resetState();
    this.director.setMode('manual');
  }

  status(): string {
    const scene = this.director.scene();
    const np = this.playback.nowPlaying().music;
    return [
      `Scene: ${scene?.label ?? 'none'}${this.director.locked ? ' (locked)' : ''}`,
      `Track: ${np ? np.title : 'nothing'}`,
      `Mode: ${this.director.mode}`,
      `Listening: ${this.listening && this.settings.ears.enabled ? 'on' : 'off'}${this.excluded.size ? ` (${this.excluded.size} opted out)` : ''}`,
    ].join('\n');
  }

  autocomplete(
    kind: 'scene' | 'track' | 'sfx',
    query: string,
    userId: string,
  ): { name: string; value: string }[] {
    const q = query.toLowerCase();
    if (kind === 'scene') {
      return this.config
        .get('scenes')
        .scenes.filter((s) => s.label.toLowerCase().includes(q) || s.id.includes(q))
        .map((s) => ({ name: s.label, value: s.id }));
    }
    if (kind === 'track') {
      return this.repo
        .list({ q: query || undefined, limit: 25 })
        .rows.filter((r) => r.kind === 'music' || r.kind === 'ambience')
        .map((r) => ({ name: r.album ? `${r.title} · ${r.album}` : r.title, value: r.id }));
    }
    const me = this.triggers.playerByUser(userId)?.id;
    const gm = this.isGmUser(userId);
    return this.soundboard()
      .filter((b) => gm || !b.playerId || b.playerId === me)
      .filter((b) => b.label.toLowerCase().includes(q))
      .sort((a, b) => Number(b.playerId === me) - Number(a.playerId === me))
      .map((b) => ({ name: b.character ? `${b.label} · ${b.character}` : b.label, value: b.id }));
  }

  /* ------------------------------- snapshot ------------------------------- */

  players(): PlayerView[] {
    const players = this.config.get('players').players;
    const inVoice = new Map((this.discord?.membersInChannel() ?? []).map((m) => [m.userId, m]));
    const views: PlayerView[] = players.map((p) => ({
      id: p.id,
      userId: p.discordUserId ?? null,
      displayName: p.displayName,
      character: p.character ?? null,
      role: p.role,
      inVoice: p.discordUserId ? inVoice.has(p.discordUserId) : false,
      speaking: p.discordUserId ? this.speaking.has(p.discordUserId) : false,
      listening: p.discordUserId ? !this.excluded.has(p.discordUserId) : true,
      colour: p.colour ?? null,
    }));
    // People in voice without a profile still get a blip.
    for (const m of inVoice.values()) {
      if (m.bot || players.some((p) => p.discordUserId === m.userId)) continue;
      views.push({
        id: m.userId,
        userId: m.userId,
        displayName: m.name,
        character: null,
        role: 'player',
        inVoice: true,
        speaking: this.speaking.has(m.userId),
        listening: !this.excluded.has(m.userId),
        colour: null,
      });
    }
    return views;
  }

  snapshot(): StateSnapshot {
    const s = this.settings;
    const m = this.mixer.snapshot();
    const now = Date.now();
    const np = this.playback.nowPlaying();
    const next = this.director.peekNext();
    const voice = this.discord?.voiceState ?? {
      state: 'disconnected' as const,
      channelId: null,
      channelName: null,
    };
    const health = {} as StateSnapshot['health'];
    for (const c of HealthComponent.options)
      health[c] = this.health.get(c) ?? { status: 'ok', message: '' };
    const game = this.hooks.state();
    return {
      version: VERSION,
      startedAt: this.startedAt,
      voice: { ...voice, channels: this.discord?.voiceChannels() ?? [] },
      automation: { mode: this.director.mode, locked: this.director.locked },
      scene: {
        current: this.director.current,
        previous: this.director.previous,
        undoUntil: this.director.undoUntil,
        scenes: this.config.get('scenes').scenes.map((sc) => ({
          id: sc.id,
          label: sc.label,
          manualOnly: sc.manualOnly,
          priority: sc.priority,
          score: Math.round(this.director.scorer.score(sc.id, now) * 100) / 100,
        })),
        suggestion: this.director.suggestion,
        tensionStep: this.director.tensionStep,
      },
      mixer: {
        master: m.master,
        paused: m.paused,
        ducking: {
          enabled: this.mixer.duckingOptions.enabled,
          depthDb: this.mixer.duckingOptions.depthDb,
        },
        layers: {
          music: {
            gain: m.layers.music.gain,
            muted: m.layers.music.muted,
            level: m.layers.music.level,
          },
          ambience: {
            gain: m.layers.ambience.gain,
            muted: m.layers.ambience.muted,
            level: m.layers.ambience.level,
          },
          sfx: { gain: m.layers.sfx.gain, muted: m.layers.sfx.muted, level: m.layers.sfx.level },
        },
      },
      nowPlaying: {
        music: np.music,
        next: next
          ? {
              trackId: next.id,
              title: next.title,
              album: next.album,
              durationS: next.durationS,
              positionS: 0,
            }
          : null,
        ambience: np.ambience,
      },
      players: this.players(),
      listening: { enabled: this.listening && s.ears.enabled, excludedUserIds: [...this.excluded] },
      game: { despairPool: game.despairPool, focus: game.focus, inCombat: game.inCombat },
      soundboard: this.soundboard(),
      health,
      ui: s.ui,
      lan: { enabled: this.opts.env.CANTINA_LAN || s.lan.enabled },
    };
  }
}
