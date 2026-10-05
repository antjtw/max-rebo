import {
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionDisconnectReason,
  VoiceConnectionStatus,
  type AudioPlayer,
  type VoiceConnection,
} from '@discordjs/voice';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type Guild,
  type Message,
  type VoiceBasedChannel,
} from 'discord.js';
import type { Settings, VoiceConnectionState } from '@cantina/shared';
import type { EventBus } from '../../bus/bus.ts';
import { DiscordSink } from '../../mixer/outputs/discord-sink.ts';
import { OpusCodec } from '../../mixer/outputs/opus.ts';
import type { Logger } from '../../util/logger.ts';
import { handleAutocomplete, handleCommand, type CommandActions } from './commands.ts';
import { backoffMs, decidePresence } from './presence.ts';

export interface DiscordAdapterOptions {
  token: string;
  guildId: string;
  bus: EventBus;
  log: Logger;
  settings: () => Settings;
  actions: CommandActions;
  /** Called with the DiscordSink when voice is ready, so the mixer clock can feed it. */
  attachSink: (sink: DiscordSink) => void;
  detachSink: (sink: DiscordSink) => void;
  /** Decoded 48 kHz stereo s16 PCM per speaking user (memory only). */
  onUserAudio?: (userId: string, pcm: Buffer) => void;
  onUserAudioEnd?: (userId: string) => void;
  /** Whether a user's audio may leave the adapter (opt-outs are enforced at the source). */
  isListenedTo?: (userId: string) => boolean;
  onTextMessage?: (msg: {
    channelId: string;
    authorId: string;
    authorIsBot: boolean;
    content: string;
  }) => void;
  /** Fade out before an automatic leave. */
  beforeLeave?: () => Promise<void>;
}

/**
 * Discord integration (SPEC §5): gateway, slash commands, voice out via one long-lived resource,
 * per-user receive (the DAVE spike), auto-join/leave and reconnection with backoff.
 */
export class DiscordAdapter {
  readonly client: Client;
  private guild: Guild | null = null;
  private connection: VoiceConnection | null = null;
  private player: AudioPlayer | null = null;
  private sink: DiscordSink | null = null;
  private channelId: string | null = null;
  private state: VoiceConnectionState = 'disconnected';
  private leaveTimer: NodeJS.Timeout | null = null;
  private manuallyLeftChannelId: string | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private decoders = new Map<string, OpusCodec>();
  private levelAt = new Map<string, number>();
  private destroyed = false;
  private listeningNick = false;

  constructor(private readonly o: DiscordAdapterOptions) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });
  }

  get voiceState(): {
    state: VoiceConnectionState;
    channelId: string | null;
    channelName: string | null;
  } {
    const ch = this.channelId ? this.guild?.channels.cache.get(this.channelId) : null;
    return { state: this.state, channelId: this.channelId, channelName: ch?.name ?? null };
  }

  async start(): Promise<void> {
    const { client, o } = this;
    client.once(Events.ClientReady, async () => {
      try {
        this.guild = await client.guilds.fetch(o.guildId);
        await this.guild.channels.fetch();
        o.log.info({ guild: this.guild.name }, 'discord ready');
        o.bus.emit('system.health', {
          component: 'discord',
          status: 'ok',
          message: `Connected to ${this.guild.name}`,
        });
        this.evaluatePresence();
      } catch (err) {
        o.bus.emit('system.health', {
          component: 'discord',
          status: 'down',
          message: `Guild ${o.guildId} not reachable: ${(err as Error).message}. Invite the bot (docs/SETUP-DISCORD.md).`,
        });
      }
    });
    client.on(Events.InteractionCreate, async (i) => {
      try {
        if (i.isChatInputCommand()) await handleCommand(i, o.actions);
        else if (i.isAutocomplete()) await handleAutocomplete(i, o.actions);
      } catch (err) {
        o.log.warn({ err: (err as Error).message }, 'interaction failed');
      }
    });
    client.on(Events.VoiceStateUpdate, (oldS, newS) => {
      if (newS.guild.id !== o.guildId) return;
      // The GM moving to a new channel clears a manual-leave suppression.
      if (newS.channelId !== oldS.channelId && newS.member?.id && this.isGmUser(newS.member.id)) {
        if (newS.channelId !== this.manuallyLeftChannelId) this.manuallyLeftChannelId = null;
      }
      this.evaluatePresence();
    });
    client.on(Events.MessageCreate, (m: Message) => {
      if (!m.guildId || m.guildId !== o.guildId) return;
      o.onTextMessage?.({
        channelId: m.channelId,
        authorId: m.author.id,
        authorIsBot: m.author.bot,
        content: m.content,
      });
    });
    client.on(Events.ShardDisconnect, () =>
      o.bus.emit('system.health', {
        component: 'discord',
        status: 'degraded',
        message: 'Gateway disconnected; reconnecting',
      }),
    );
    client.on(Events.ShardResume, () =>
      o.bus.emit('system.health', {
        component: 'discord',
        status: 'ok',
        message: 'Gateway resumed',
      }),
    );
    client.on(Events.Error, (err) => o.log.warn({ err: err.message }, 'discord client error'));
    client.rest.on('rateLimited', (info) =>
      o.log.warn({ route: info.route, retryAfter: info.retryAfter }, 'rate limited'),
    );

    try {
      await client.login(o.token);
    } catch (err) {
      const msg = (err as Error).message;
      o.bus.emit('system.health', {
        component: 'discord',
        status: 'down',
        message: /token/i.test(msg)
          ? 'Discord token is invalid. Reset it in the Developer Portal (docs/SETUP-DISCORD.md §2).'
          : `Discord login failed: ${msg}`,
      });
      throw err;
    }
  }

  private isGmUser(userId: string): boolean {
    const d = this.o.settings().discord;
    return userId === d.gmUserId || d.gmUserIds.includes(userId);
  }

  /** Voice channels with their occupants, for the dashboard's Join control. */
  voiceChannels(): {
    id: string;
    name: string;
    members: { userId: string; name: string; bot: boolean }[];
  }[] {
    if (!this.guild) return [];
    return [...this.guild.channels.cache.values()]
      .filter(
        (c): c is VoiceBasedChannel =>
          c.type === ChannelType.GuildVoice || c.type === ChannelType.GuildStageVoice,
      )
      .sort((a, b) => a.position - b.position)
      .map((c) => ({
        id: c.id,
        name: c.name,
        members: [...c.members.values()].map((m) => ({
          userId: m.id,
          name: m.displayName,
          bot: m.user.bot,
        })),
      }));
  }

  /** Users currently in the bot's voice channel. */
  membersInChannel(): { userId: string; name: string; bot: boolean }[] {
    return this.voiceChannels().find((c) => c.id === this.channelId)?.members ?? [];
  }

  userVoiceChannel(userId: string): string | null {
    return this.guild?.voiceStates.cache.get(userId)?.channelId ?? null;
  }

  private evaluatePresence(): void {
    if (!this.guild || this.destroyed) return;
    const s = this.o.settings().discord;
    const states = new Map<string, { channelId: string; bot: boolean }>();
    for (const vs of this.guild.voiceStates.cache.values()) {
      if (vs.channelId)
        states.set(vs.id, { channelId: vs.channelId, bot: vs.member?.user.bot ?? false });
    }
    const action = decidePresence({
      autoJoin: s.autoJoin,
      gmUserIds: [s.gmUserId, ...s.gmUserIds].filter(Boolean),
      botChannelId: this.channelId,
      voiceStates: states,
      manuallyLeftChannelId: this.manuallyLeftChannelId,
    });
    switch (action.kind) {
      case 'join':
        this.o.log.info({ channelId: action.channelId }, 'auto-joining GM');
        void this.join(action.channelId).catch((err) =>
          this.o.log.warn({ err: err.message }, 'auto-join failed'),
        );
        break;
      case 'schedule_leave':
        if (!this.leaveTimer) {
          this.leaveTimer = setTimeout(async () => {
            this.leaveTimer = null;
            if (this.membersInChannel().some((m) => !m.bot)) return;
            this.o.log.info('channel empty: leaving');
            await this.o.beforeLeave?.();
            await this.leave(false);
          }, s.autoLeaveAfterS * 1000);
        }
        break;
      case 'cancel_leave':
        if (this.leaveTimer) clearTimeout(this.leaveTimer);
        this.leaveTimer = null;
        break;
    }
  }

  private setState(state: VoiceConnectionState, error?: string): void {
    this.state = state;
    const v = this.voiceState;
    this.o.bus.emit('voice.connection', {
      state,
      channelId: v.channelId,
      channelName: v.channelName,
      error,
    });
    this.o.bus.emit('system.health', {
      component: 'voice',
      status:
        state === 'ready'
          ? 'ok'
          : state === 'disconnected' && !error
            ? 'ok'
            : state === 'disconnected'
              ? 'down'
              : 'degraded',
      message:
        error ??
        (state === 'ready'
          ? `In ${v.channelName ?? 'voice'}`
          : state === 'disconnected'
            ? 'Not in voice'
            : state === 'reconnecting'
              ? 'Reconnecting'
              : 'Connecting'),
    });
  }

  async join(channelId: string): Promise<void> {
    if (!this.guild) throw new Error('Discord is not connected yet');
    const channel = this.guild.channels.cache.get(channelId);
    if (!channel || !channel.isVoiceBased()) throw new Error('That is not a voice channel');
    if (this.connection && this.channelId === channelId && this.state === 'ready') return;
    this.teardownConnection();
    this.manuallyLeftChannelId = null;
    this.channelId = channelId;
    this.setState('connecting');

    const connection = joinVoiceChannel({
      channelId,
      guildId: this.guild.id,
      adapterCreator: this.guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
      daveEncryption: true,
    });
    this.connection = connection;
    connection.on('error', (err) =>
      this.o.log.warn({ err: err.message }, 'voice connection error'),
    );
    connection.on('stateChange', (_old, next) => {
      if (this.connection !== connection) return;
      if (next.status === VoiceConnectionStatus.Ready) {
        this.reconnectAttempt = 0;
        this.setState('ready');
        this.attachReceiver(connection);
      } else if (next.status === VoiceConnectionStatus.Disconnected) {
        if (
          next.reason === VoiceConnectionDisconnectReason.WebSocketClose &&
          next.closeCode === 4017
        ) {
          this.setState(
            'disconnected',
            'Discord refused voice without end-to-end encryption (DAVE, close code 4017). Run `npm run doctor` and update @discordjs/voice and @snazzah/davey.',
          );
          this.teardownConnection();
          return;
        }
        void this.handleDisconnect(connection);
      }
    });

    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play, maxMissedFrames: 250 },
    });
    this.player.on('error', (err) => this.o.log.warn({ err: err.message }, 'audio player error'));
    this.player.on('stateChange', (_o, n) => {
      // The resource is long-lived; if it ever ends, start a fresh one.
      if (n.status === AudioPlayerStatus.Idle && this.connection === connection && !this.destroyed)
        this.startResource();
    });
    connection.subscribe(this.player);
    this.startResource();

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    } catch {
      if (this.connection === connection && this.state !== 'ready')
        void this.handleDisconnect(connection);
    }
  }

  private startResource(): void {
    if (!this.player) return;
    if (this.sink) {
      this.o.detachSink(this.sink);
      this.sink.close();
    }
    this.sink = new DiscordSink(3);
    this.o.attachSink(this.sink);
    this.player.play(createAudioResource(this.sink.stream, { inputType: StreamType.Opus }));
  }

  private async handleDisconnect(connection: VoiceConnection): Promise<void> {
    if (this.destroyed || this.connection !== connection) return;
    this.setState('reconnecting');
    try {
      // Recoverable: Discord is moving us or re-negotiating.
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
      ]);
      return;
    } catch {
      // Fall through to a manual rejoin with backoff.
    }
    const channelId = this.channelId;
    if (!channelId) return;
    const delay = backoffMs(this.reconnectAttempt++);
    this.o.log.warn({ delay, attempt: this.reconnectAttempt }, 'voice reconnect scheduled');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.channelId !== channelId || this.destroyed) return;
      this.teardownConnection(false);
      this.channelId = channelId;
      void this.join(channelId).catch(() => void 0);
    }, delay);
  }

  /**
   * DAVE receive spike (SPEC §18 P1): one Opus stream per speaking user, decoded in memory to PCM.
   * Levels are always computed (for the speaking blips); audio only leaves if the user is listened to.
   */
  private attachReceiver(connection: VoiceConnection): void {
    const receiver = connection.receiver;
    receiver.speaking.removeAllListeners('start');
    receiver.speaking.on('start', (userId: string) => {
      if (receiver.subscriptions.has(userId)) return;
      const member = this.guild?.members.cache.get(userId);
      if (member?.user.bot) return;
      this.o.bus.emit('voice.speaking', { userId, speaking: true });
      const stream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: this.o.settings().ears.silenceMs },
      });
      let decoder = this.decoders.get(userId);
      if (!decoder) {
        decoder = new OpusCodec('voip');
        this.decoders.set(userId, decoder);
      }
      const dec = decoder;
      stream.on('data', (packet: Buffer) => {
        let pcm: Buffer;
        try {
          pcm = dec.decode(packet);
        } catch {
          return; // undecodable packet (e.g. during a DAVE transition)
        }
        this.emitLevel(userId, pcm);
        if (this.o.onUserAudio && (this.o.isListenedTo?.(userId) ?? false))
          this.o.onUserAudio(userId, pcm);
      });
      const done = () => {
        this.o.bus.emit('voice.speaking', { userId, speaking: false });
        this.o.bus.emit('voice.level', { userId, rms: 0 });
        this.o.onUserAudioEnd?.(userId);
      };
      stream.once('end', done);
      stream.once('error', (err) => {
        this.o.log.debug({ err: err.message }, 'receive stream error');
        done();
      });
    });
  }

  private emitLevel(userId: string, pcm: Buffer): void {
    const now = Date.now();
    if (now - (this.levelAt.get(userId) ?? 0) < 100) return; // 10 Hz
    this.levelAt.set(userId, now);
    let sum = 0;
    const n = Math.floor(pcm.byteLength / 2);
    for (let i = 0; i < n; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      sum += v * v;
    }
    this.o.bus.emit('voice.level', {
      userId,
      rms: Math.round(Math.sqrt(sum / Math.max(1, n)) * 1000) / 1000,
    });
  }

  private teardownConnection(clearChannel = true): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.sink) {
      this.o.detachSink(this.sink);
      this.sink.close();
      this.sink = null;
    }
    this.player?.stop(true);
    this.player = null;
    const c = this.connection;
    this.connection = null;
    if (c && c.state.status !== VoiceConnectionStatus.Destroyed) c.destroy();
    for (const d of this.decoders.values()) d.close();
    this.decoders.clear();
    if (clearChannel) this.channelId = null;
  }

  /** Leave voice. A manual leave suppresses auto-join until the GM changes channel. */
  async leave(manual = true): Promise<void> {
    if (manual) this.manuallyLeftChannelId = this.channelId;
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.teardownConnection();
    this.setState('disconnected');
  }

  async announce(text: string): Promise<void> {
    const id = this.o.settings().discord.announceChannelId;
    if (!id || !this.guild) return;
    try {
      const ch = await this.guild.channels.fetch(id);
      if (ch?.isTextBased()) await ch.send(text);
    } catch (err) {
      this.o.log.warn({ err: (err as Error).message }, 'announcement failed');
    }
  }

  /** "Cantina · listening" nickname suffix while speech recognition is on (SPEC §5.4). */
  async setListeningIndicator(on: boolean): Promise<void> {
    if (!this.guild || !this.o.settings().discord.nicknameIndicator || on === this.listeningNick)
      return;
    this.listeningNick = on;
    try {
      const me = this.guild.members.me ?? (await this.guild.members.fetchMe());
      const base = me.user.globalName ?? me.user.username;
      await me.setNickname(on ? `${base} · listening` : null);
    } catch {
      // Missing Change Nickname permission: optional.
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.teardownConnection();
    await this.client.destroy();
  }
}
