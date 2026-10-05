import { describe, expect, it } from 'vitest';
import { backoffMs, decidePresence, isGm, type PresenceInput } from './presence.ts';

const GM = '100';
const P1 = '200';
const BOT = '999';

function input(
  states: [string, string, boolean?][],
  over: Partial<PresenceInput> = {},
): PresenceInput {
  return {
    autoJoin: true,
    gmUserIds: [GM],
    botChannelId: null,
    manuallyLeftChannelId: null,
    voiceStates: new Map(states.map(([u, c, bot]) => [u, { channelId: c, bot: !!bot }])),
    ...over,
  };
}

describe('decidePresence', () => {
  it('follows the GM into voice', () => {
    expect(decidePresence(input([[GM, 'vc1']]))).toEqual({
      kind: 'join',
      channelId: 'vc1',
      reason: 'gm_joined',
    });
  });

  it('does not follow non-GMs', () => {
    expect(decidePresence(input([[P1, 'vc1']]))).toEqual({ kind: 'none' });
  });

  it('respects auto-join off', () => {
    expect(decidePresence(input([[GM, 'vc1']], { autoJoin: false }))).toEqual({ kind: 'none' });
  });

  it('does not rejoin a channel it was told to leave', () => {
    expect(decidePresence(input([[GM, 'vc1']], { manuallyLeftChannelId: 'vc1' }))).toEqual({
      kind: 'none',
    });
  });

  it('schedules leaving when only bots remain', () => {
    const i = input([[BOT, 'vc1', true]], { botChannelId: 'vc1' });
    expect(decidePresence(i)).toEqual({ kind: 'schedule_leave', reason: 'empty' });
  });

  it('stays when the GM leaves but players remain (Q24)', () => {
    const i = input(
      [
        [P1, 'vc1'],
        [BOT, 'vc1', true],
      ],
      { botChannelId: 'vc1' },
    );
    expect(decidePresence(i)).toEqual({ kind: 'cancel_leave' });
  });
});

describe('isGm', () => {
  const cfg = { gmUserId: GM, gmUserIds: [], gmRoleId: 'role-gm' };
  it('matches by user id or role', () => {
    expect(isGm(GM, [], cfg)).toBe(true);
    expect(isGm(P1, ['role-gm'], cfg)).toBe(true);
    expect(isGm(P1, ['other'], cfg)).toBe(false);
  });
  it('treats everyone as GM until a GM is configured', () => {
    expect(isGm(P1, [], { gmUserId: '', gmUserIds: [], gmRoleId: '' })).toBe(true);
  });
});

describe('backoffMs', () => {
  it('doubles up to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});
