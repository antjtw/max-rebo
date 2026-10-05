import type { HealthComponent, Mode } from '@cantina/shared';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';
import { VoiceControl } from '../panels/Voice.tsx';
import { Glyph } from './Glyph.tsx';

const ROUTES = [
  ['console', 'Console'],
  ['library', 'Library'],
  ['triggers', 'Triggers'],
  ['players', 'Players'],
  ['scenes', 'Scenes'],
  ['settings', 'Settings'],
  ['simulator', 'Simulator'],
] as const;

const LAMPS: [HealthComponent, string][] = [
  ['discord', 'Discord'],
  ['voice', 'Voice'],
  ['ears', 'Ears'],
  ['library', 'Library'],
];

const HELP: Record<string, string> = {
  discord: 'Check DISCORD_TOKEN and DISCORD_GUILD_ID in .env, then run npm run doctor.',
  voice: 'Use Join below, /join in Discord, or join voice yourself (the bot follows the GM).',
  ears: 'Speech recognition. If degraded, run npm run setup; triggers from text chat still work.',
  library: 'Check CANTINA_LIBRARY_PATHS and that any external drive is connected.',
};

export function Header({ route }: { route: string }) {
  const state = useStore((s) => s.state);
  const connected = useStore((s) => s.connected);
  const setMode = (mode: Mode) => void api.post('/api/mode', { mode });
  const mode = state?.automation.mode;
  return (
    <header className="header">
      <div className="brand">
        <Glyph />
        <div>
          <div className="wordmark">
            CANTINA<small>AMBIENT ACOUSTICS CONSOLE</small>
          </div>
          <div className="maker">VANTARI ACOUSTIC SYSTEMS · MODEL AC-7</div>
        </div>
      </div>
      <nav className="nav" aria-label="Screens">
        {ROUTES.map(([id, label]) =>
          id === 'simulator' && !state?.ui.simulator ? null : (
            <a key={id} href={`#/${id}`} aria-current={route === id ? 'page' : undefined}>
              {label}
            </a>
          ),
        )}
      </nav>
      <div className="header-right">
        <div className="lamps" role="list" aria-label="System health">
          <span
            className="lamp"
            data-status={connected ? 'ok' : 'down'}
            role="listitem"
            title={connected ? 'Connected to core' : 'Reconnecting to core…'}
          >
            <i />
            <b>Core {connected ? 'OK' : 'DOWN'}</b>
          </span>
          {LAMPS.map(([c, label]) => {
            const h = state?.health[c];
            const status = h?.status ?? 'down';
            return (
              <span
                key={c}
                className="lamp"
                data-status={status}
                role="listitem"
                title={`${h?.message ?? ''}${status !== 'ok' ? `\n${HELP[c]}` : ''}`}
              >
                <i />
                <b>
                  {label} {status === 'ok' ? 'OK' : status.toUpperCase()}
                </b>
              </span>
            );
          })}
        </div>
        <div className="row">
          <VoiceControl />
          <div className="seg" role="group" aria-label="Automation mode">
            {(['manual', 'suggest', 'auto'] as const).map((m) => (
              <button
                key={m}
                className="btn small"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
              >
                {m}
              </button>
            ))}
          </div>
          <button
            className="btn small"
            aria-pressed={!!state?.automation.locked}
            onClick={() => void api.post('/api/lock', { locked: !state?.automation.locked })}
            title="Freeze the current scene (L)"
          >
            {state?.automation.locked ? '■ Locked' : 'Lock'}
          </button>
          <button
            className="btn small"
            aria-pressed={!!state?.listening.enabled}
            onClick={() => void api.post('/api/listen', { enabled: !state?.listening.enabled })}
            title="Speech recognition: local, memory only"
          >
            {state?.listening.enabled ? '● Listening' : '○ Not listening'}
          </button>
          <button
            className="btn small danger"
            onClick={() => void api.post('/api/panic')}
            title="Fade everything out and switch to Manual (Shift+P)"
          >
            Panic
          </button>
        </div>
      </div>
    </header>
  );
}
