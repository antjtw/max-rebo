import { useEffect, useState } from 'react';
import type { Settings } from '@cantina/shared';
import { YamlEditor } from '../components/YamlEditor.tsx';
import { api } from '../state/api.ts';
import { useConfig } from '../state/config.ts';
import { usePrefs } from '../state/prefs.ts';
import { useStore } from '../state/store.ts';

interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'pending';
  detail: string;
  fix?: string;
}

export function SettingsRoute() {
  const { value, save } = useConfig<Settings>('settings');
  const prefs = usePrefs();
  const state = useStore((s) => s.state);
  const [doctor, setDoctor] = useState<Check[]>([]);
  const [lan, setLan] = useState<{ enabled: boolean; pin: string | null } | null>(null);
  const [file, setFile] = useState<'settings' | 'hooks' | 'vocabulary' | 'taxonomy'>('settings');
  useEffect(() => {
    void api.get<Check[]>('/api/doctor').then(setDoctor);
    void api.get<{ enabled: boolean; pin: string | null }>('/api/lan').then(setLan);
  }, []);
  if (!value) return null;
  const set = (fn: (s: Settings) => void) => {
    const n = structuredClone(value);
    fn(n);
    void save(n);
  };
  const toggle = (label: string, checked: boolean, fn: (s: Settings, v: boolean) => void) => (
    <label className="row" style={{ marginBottom: 6 }}>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => set((s) => fn(s, e.target.checked))}
      />{' '}
      {label}
    </label>
  );
  return (
    <main className="screen">
      <div className="screen-grid">
        <section className="panel" aria-label="Display">
          <h2 className="label">Display</h2>
          {toggle('CRT effect (vignette)', value.ui.crt, (s, v) => (s.ui.crt = v))}
          {toggle('Scanlines', value.ui.scanlines, (s, v) => (s.ui.scanlines = v))}
          {toggle('Flicker', value.ui.flicker, (s, v) => (s.ui.flicker = v))}
          {toggle('Bloom on bright lines', value.ui.bloom, (s, v) => (s.ui.bloom = v))}
          {toggle('Show the Simulator screen', value.ui.simulator, (s, v) => (s.ui.simulator = v))}
          <label className="row">
            <input
              type="checkbox"
              checked={prefs.reducedMotion}
              onChange={(e) => prefs.setForceReducedMotion(e.target.checked)}
            />
            Reduced motion on this device{' '}
            {prefs.forceReducedMotion === null ? (
              <span className="micro">(following system)</span>
            ) : null}
          </label>
          <h2 className="label" style={{ marginTop: 16 }}>
            Listening and privacy
          </h2>
          {toggle('Speech recognition enabled', value.ears.enabled, (s, v) => (s.ears.enabled = v))}
          <label className="field">
            <span className="micro">
              Transcript memory (minutes; 0 = process and drop). Never written to disk.
            </span>
            <input
              className="input"
              type="number"
              min={0}
              max={60}
              value={value.ears.retentionMinutes}
              onChange={(e) => set((s) => (s.ears.retentionMinutes = Number(e.target.value)))}
            />
          </label>
          {toggle(
            'Text-chat triggers',
            value.inputs.discordText,
            (s, v) => (s.inputs.discordText = v),
          )}
          {toggle(
            'Players may fire their own SFX with /sfx',
            value.discord.sfxCommand === 'everyone',
            (s, v) => (s.discord.sfxCommand = v ? 'everyone' : 'gm'),
          )}
          <h2 className="label" style={{ marginTop: 16 }}>
            Output
          </h2>
          {toggle(
            'Play the mix through this Mac’s speakers too',
            value.outputs.localSpeakers,
            (s, v) => (s.outputs.localSpeakers = v),
          )}
          {toggle(
            'Auto-join when the GM joins voice',
            value.discord.autoJoin,
            (s, v) => (s.discord.autoJoin = v),
          )}
          <h2 className="label" style={{ marginTop: 16 }}>
            LAN / iPad
          </h2>
          {toggle(
            'Allow other devices on the network (restart required)',
            value.lan.enabled,
            (s, v) => (s.lan.enabled = v),
          )}
          {lan?.enabled ? (
            <p>
              PIN for other devices:{' '}
              <strong className="signal" style={{ fontSize: 18, letterSpacing: '0.2em' }}>
                {lan.pin ?? '(shown on the Mac)'}
              </strong>
            </p>
          ) : (
            <p className="micro">Off: the console only answers on 127.0.0.1.</p>
          )}
        </section>
        <section className="panel" aria-label="Doctor">
          <h2 className="label">
            Doctor
            <button
              className="btn small"
              onClick={() => void api.get<Check[]>('/api/doctor').then(setDoctor)}
            >
              Re-run
            </button>
          </h2>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {doctor.map((c) => (
              <li key={c.name} style={{ marginBottom: 6 }}>
                <span className={c.status === 'fail' ? 'signal' : c.status === 'ok' ? '' : 'dim'}>
                  {c.status === 'ok'
                    ? '✔'
                    : c.status === 'fail'
                      ? '✘'
                      : c.status === 'warn'
                        ? '!'
                        : '…'}{' '}
                  {c.name}
                </span>
                : <span className="dim">{c.detail}</span>
                {c.fix ? (
                  <div className="micro" style={{ textTransform: 'none', letterSpacing: 0 }}>
                    → {c.fix}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          <p className="micro">Version {state?.version}</p>
        </section>
      </div>
      <section className="panel" style={{ marginTop: 'var(--gap)' }} aria-label="Config files">
        <h2 className="label">
          Config files
          <span className="seg">
            {(['settings', 'hooks', 'vocabulary', 'taxonomy'] as const).map((f) => (
              <button
                key={f}
                className="btn small"
                aria-pressed={file === f}
                onClick={() => setFile(f)}
              >
                {f}
              </button>
            ))}
          </span>
        </h2>
        <YamlEditor key={file} name={file} rows={20} />
      </section>
    </main>
  );
}
