/**
 * Auto-join / auto-leave decisions (SPEC §5.2), kept pure so they can be tested without Discord.
 *
 * - When the GM joins a voice channel and auto-join is on, follow them (within 3 s).
 * - When the bot's channel has no humans left, fade out and leave after `autoLeaveAfterS`.
 * - Q24: the bot does not leave just because the GM leaves while players remain.
 */

export interface ChannelMember {
  userId: string;
  bot: boolean;
}

export interface PresenceInput {
  autoJoin: boolean;
  gmUserIds: string[];
  /** Channel the bot is in (or connecting to), if any. */
  botChannelId: string | null;
  /** userId → channelId for everyone currently in voice in the guild. */
  voiceStates: Map<string, { channelId: string; bot: boolean }>;
  /** Set when the bot was explicitly told to leave; suppresses auto-join until the GM moves. */
  manuallyLeftChannelId: string | null;
}

export type PresenceAction =
  | { kind: 'join'; channelId: string; reason: 'gm_joined' }
  | { kind: 'schedule_leave'; reason: 'empty' }
  | { kind: 'cancel_leave' }
  | { kind: 'none' };

export function humansIn(channelId: string, states: PresenceInput['voiceStates']): number {
  let n = 0;
  for (const s of states.values()) if (s.channelId === channelId && !s.bot) n++;
  return n;
}

export function decidePresence(input: PresenceInput): PresenceAction {
  const { botChannelId, voiceStates } = input;
  if (botChannelId) {
    return humansIn(botChannelId, voiceStates) === 0
      ? { kind: 'schedule_leave', reason: 'empty' }
      : { kind: 'cancel_leave' };
  }
  if (!input.autoJoin) return { kind: 'none' };
  const gm = gmChannel(input);
  if (gm && gm !== input.manuallyLeftChannelId)
    return { kind: 'join', channelId: gm, reason: 'gm_joined' };
  return { kind: 'none' };
}

function gmChannel(input: PresenceInput): string | null {
  for (const id of input.gmUserIds) {
    const s = input.voiceStates.get(id);
    if (s) return s.channelId;
  }
  return null;
}

/** Whether a member counts as GM: by user ID list or by role (SPEC §5.3). */
export function isGm(
  userId: string,
  roleIds: Iterable<string>,
  cfg: { gmUserId: string; gmUserIds: string[]; gmRoleId: string },
): boolean {
  if (cfg.gmUserId && userId === cfg.gmUserId) return true;
  if (cfg.gmUserIds.includes(userId)) return true;
  if (cfg.gmRoleId) for (const r of roleIds) if (r === cfg.gmRoleId) return true;
  // No GM configured at all: treat everyone as GM so the bot is usable before setup is complete.
  return !cfg.gmUserId && cfg.gmUserIds.length === 0 && !cfg.gmRoleId;
}

/** Exponential reconnect backoff: 1, 2, 4, 8 … max 30 s (SPEC §14). */
export function backoffMs(attempt: number): number {
  return Math.min(30_000, 1000 * Math.pow(2, Math.max(0, attempt)));
}
