import {
  MessageFlags,
  SlashCommandBuilder,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type RESTPostAPIChatInputApplicationCommandsJSONBody,
} from 'discord.js';
import { LAYERS, MODES, type Layer, type Mode } from '@cantina/shared';

/** What slash commands can ask the app to do. Implemented by the Cantina app (app.ts). */
export interface CommandActions {
  joinUserChannel(userId: string): Promise<string>;
  leave(): Promise<void>;
  setScene(sceneId: string): Promise<string>;
  playTrack(trackId: string): Promise<string>;
  fireSfx(sfxId: string, userId: string): Promise<string>;
  stop(layer?: Layer): void;
  setVolume(layer: Layer, value: number): void;
  setMode(mode: Mode): void;
  setLocked(locked: boolean): void;
  setListening(enabled: boolean): void;
  setUserListening(userId: string, enabled: boolean): void;
  panic(): void;
  status(): string;
  autocomplete(
    kind: 'scene' | 'track' | 'sfx',
    query: string,
    userId: string,
  ): { name: string; value: string }[];
  isGm(userId: string, roleIds: string[]): boolean;
  sfxAllowed(userId: string, sfxId: string, gm: boolean): boolean;
}

const layerChoices = LAYERS.map((l) => ({ name: l, value: l }));

/** Slash command definitions (SPEC §5.3). */
export function commandDefinitions(): RESTPostAPIChatInputApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder().setName('join').setDescription('Join your voice channel'),
    new SlashCommandBuilder().setName('leave').setDescription('Leave voice'),
    new SlashCommandBuilder()
      .setName('scene')
      .setDescription('Switch scene')
      .addStringOption((o) =>
        o.setName('name').setDescription('Scene').setRequired(true).setAutocomplete(true),
      ),
    new SlashCommandBuilder()
      .setName('play')
      .setDescription('Play a specific track now')
      .addStringOption((o) =>
        o.setName('query').setDescription('Track').setRequired(true).setAutocomplete(true),
      ),
    new SlashCommandBuilder()
      .setName('sfx')
      .setDescription('Fire a sound effect')
      .addStringOption((o) =>
        o.setName('name').setDescription('Sound').setRequired(true).setAutocomplete(true),
      ),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Fade out one layer, or everything')
      .addStringOption((o) =>
        o
          .setName('layer')
          .setDescription('Layer')
          .addChoices(...layerChoices),
      ),
    new SlashCommandBuilder()
      .setName('volume')
      .setDescription('Set a layer volume')
      .addStringOption((o) =>
        o
          .setName('layer')
          .setDescription('Layer')
          .setRequired(true)
          .addChoices(...layerChoices),
      )
      .addIntegerOption((o) =>
        o
          .setName('value')
          .setDescription('0–100')
          .setRequired(true)
          .setMinValue(0)
          .setMaxValue(100),
      ),
    new SlashCommandBuilder()
      .setName('mode')
      .setDescription('Automation mode')
      .addStringOption((o) =>
        o
          .setName('mode')
          .setDescription('Mode')
          .setRequired(true)
          .addChoices(...MODES.map((m) => ({ name: m, value: m }))),
      ),
    new SlashCommandBuilder().setName('lock').setDescription('Freeze the current scene'),
    new SlashCommandBuilder().setName('unlock').setDescription('Unfreeze the scene'),
    new SlashCommandBuilder()
      .setName('listen')
      .setDescription('Speech recognition on or off')
      .addSubcommand((s) =>
        s
          .setName('all')
          .setDescription('Global switch (GM)')
          .addStringOption((o) =>
            o
              .setName('state')
              .setDescription('on/off')
              .setRequired(true)
              .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
          ),
      )
      .addSubcommand((s) =>
        s
          .setName('me')
          .setDescription('Opt yourself in or out')
          .addStringOption((o) =>
            o
              .setName('state')
              .setDescription('on/off')
              .setRequired(true)
              .addChoices({ name: 'on', value: 'on' }, { name: 'off', value: 'off' }),
          ),
      ),
    new SlashCommandBuilder()
      .setName('panic')
      .setDescription('Fade everything to silence and switch to Manual'),
    new SlashCommandBuilder()
      .setName('status')
      .setDescription('Scene, track, mode and listening state'),
  ].map((b) => b.toJSON() as RESTPostAPIChatInputApplicationCommandsJSONBody);
}

const GM_ONLY = new Set([
  'join',
  'leave',
  'scene',
  'play',
  'stop',
  'volume',
  'mode',
  'lock',
  'unlock',
  'panic',
]);

function roleIds(i: ChatInputCommandInteraction | AutocompleteInteraction): string[] {
  const roles = i.member?.roles;
  if (!roles) return [];
  return Array.isArray(roles) ? roles : [...roles.cache.keys()];
}

export async function handleCommand(
  i: ChatInputCommandInteraction,
  a: CommandActions,
): Promise<void> {
  const gm = a.isGm(i.user.id, roleIds(i));
  const reply = (content: string) =>
    i.replied || i.deferred
      ? i.editReply({ content })
      : i.reply({ content, flags: MessageFlags.Ephemeral });

  const isListenAll = i.commandName === 'listen' && i.options.getSubcommand(false) === 'all';
  if ((GM_ONLY.has(i.commandName) || isListenAll) && !gm) {
    await reply('Only the GM can do that.');
    return;
  }
  try {
    switch (i.commandName) {
      case 'join':
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await reply(await a.joinUserChannel(i.user.id));
        return;
      case 'leave':
        await a.leave();
        await reply('Left voice.');
        return;
      case 'scene':
        await reply(await a.setScene(i.options.getString('name', true)));
        return;
      case 'play':
        await i.deferReply({ flags: MessageFlags.Ephemeral });
        await reply(await a.playTrack(i.options.getString('query', true)));
        return;
      case 'sfx': {
        const id = i.options.getString('name', true);
        if (!a.sfxAllowed(i.user.id, id, gm)) {
          await reply("That sound isn't yours to fire.");
          return;
        }
        await reply(await a.fireSfx(id, i.user.id));
        return;
      }
      case 'stop': {
        const layer = i.options.getString('layer') as Layer | null;
        a.stop(layer ?? undefined);
        await reply(layer ? `Fading out ${layer}.` : 'Fading out everything.');
        return;
      }
      case 'volume': {
        const layer = i.options.getString('layer', true) as Layer;
        const value = i.options.getInteger('value', true);
        a.setVolume(layer, value);
        await reply(`${layer} volume ${value}.`);
        return;
      }
      case 'mode': {
        const mode = i.options.getString('mode', true) as Mode;
        a.setMode(mode);
        await reply(`Mode: ${mode}.`);
        return;
      }
      case 'lock':
      case 'unlock':
        a.setLocked(i.commandName === 'lock');
        await reply(i.commandName === 'lock' ? 'Scene locked.' : 'Scene unlocked.');
        return;
      case 'listen': {
        const on = i.options.getString('state', true) === 'on';
        if (i.options.getSubcommand() === 'all') {
          a.setListening(on);
          await reply(on ? 'Listening for cues.' : 'Speech recognition off.');
        } else {
          a.setUserListening(i.user.id, on);
          await reply(
            on
              ? "You're opted in to cue listening."
              : "You're opted out. Your voice won't be processed.",
          );
        }
        return;
      }
      case 'panic':
        a.panic();
        await reply('Panic: fading to silence, mode set to Manual.');
        return;
      case 'status':
        await reply(a.status());
        return;
      default:
        await reply('Unknown command.');
    }
  } catch (err) {
    await reply(`Couldn't do that: ${(err as Error).message}`);
  }
}

export async function handleAutocomplete(
  i: AutocompleteInteraction,
  a: CommandActions,
): Promise<void> {
  const focused = i.options.getFocused(true);
  const kind =
    i.commandName === 'scene'
      ? 'scene'
      : i.commandName === 'play'
        ? 'track'
        : i.commandName === 'sfx'
          ? 'sfx'
          : null;
  if (!kind) return i.respond([]);
  const choices = a
    .autocomplete(kind, String(focused.value ?? ''), i.user.id)
    .slice(0, 25)
    .map((c) => ({ name: c.name.slice(0, 100), value: c.value.slice(0, 100) }));
  await i.respond(choices);
}
