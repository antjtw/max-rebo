import { useState } from 'react';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

const QUICK = [
  'I ignite my lightsaber',
  'I deactivate my lightsaber',
  "I don't ignite my lightsaber yet",
  'Kael ignites his saber',
  'I fire my blaster',
  'Punch it!',
  "It's an ambush! Weapons out!",
  'The GM takes the Focus',
  'I spend two Despair',
  'We take a full rest',
];

/** Simulator (SPEC §7.1): typed lines attributed to any player, through the real engine. */
export function SimulatorRoute() {
  const state = useStore((s) => s.state);
  const log = useStore((s) => s.log);
  const [player, setPlayer] = useState('');
  const [text, setText] = useState('');
  const pid = player || state?.players[0]?.id || 'ant';
  const send = (t: string) => {
    if (!t.trim()) return;
    void api
      .post('/api/sim/say', { playerId: pid, text: t })
      .catch((e: Error) => useStore.getState().setToast(e.message, 'error'));
  };
  return (
    <main className="screen">
      <div className="screen-grid">
        <section className="panel" aria-label="Simulator">
          <h2 className="label">Simulator</h2>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              send(text);
              setText('');
            }}
          >
            <select
              className="input"
              aria-label="Speak as"
              value={pid}
              onChange={(e) => setPlayer(e.target.value)}
            >
              {state?.players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                  {p.character ? ` (${p.character})` : ''}
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: 1 }}
              aria-label="Line to say"
              placeholder="Type a line and press Enter"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <button className="btn primary small" type="submit">
              Say
            </button>
          </form>
          <div className="row wrap" style={{ marginTop: 10 }}>
            {QUICK.map((q) => (
              <button key={q} className="btn small" onClick={() => send(q)}>
                {q}
              </button>
            ))}
          </div>
          <p className="micro">
            Also from a terminal:{' '}
            <code>npm run sim -- --as james --say "I ignite my lightsaber"</code>
          </p>
        </section>
        <section className="panel" aria-label="Recent events">
          <h2 className="label">What happened</h2>
          <ul className="eventlog panel-body">
            {log.slice(0, 40).map((e) => (
              <li key={e.id} className={`k-${e.kind}`}>
                <span className="t">{new Date(e.ts).toLocaleTimeString('en-GB')}</span>
                <span>{e.text}</span>
                <span className="lat">
                  {e.latencyMs != null ? `${Math.round(e.latencyMs)} ms` : ''}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
