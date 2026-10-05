import { describe, expect, it } from 'vitest';
import { commandDefinitions } from './commands.ts';

describe('slash commands', () => {
  it('defines every command in SPEC §5.3', () => {
    const names = commandDefinitions()
      .map((c) => c.name)
      .sort();
    expect(names).toEqual(
      [
        'join',
        'leave',
        'listen',
        'lock',
        'mode',
        'panic',
        'play',
        'scene',
        'sfx',
        'status',
        'stop',
        'unlock',
        'volume',
      ].sort(),
    );
  });
});
