import { useEffect, useRef, useState } from 'react';
import type { Layer } from '@cantina/shared';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

function Fader({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
}) {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  return (
    <input
      type="range"
      min={0}
      max={100}
      value={local}
      aria-label={`${label} volume`}
      onPointerDown={() => (dragging.current = true)}
      onPointerUp={() => (dragging.current = false)}
      onChange={(e) => {
        const v = Number(e.target.value);
        setLocal(v);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => onChange(v), 40);
      }}
    />
  );
}

export function LayersPanel() {
  const state = useStore((s) => s.state);
  const mixer = useStore((s) => s.mixer);
  if (!state) return null;
  const layers: Layer[] = ['music', 'ambience', 'sfx'];
  return (
    <section className="panel" aria-labelledby="layers-h">
      <h2 className="label" id="layers-h">
        Layers {mixer?.limiting ? <span className="micro signal">LIMIT</span> : null}
      </h2>
      <div className="panel-body">
        {layers.map((l) => {
          const st = state.mixer.layers[l];
          const level = mixer?.layers[l]?.level ?? 0;
          const duck = mixer?.layers[l]?.duckDb ?? 0;
          return (
            <div key={l}>
              <div className="layer">
                <span className="label">{l}</span>
                <Fader
                  label={l}
                  value={st.gain}
                  onChange={(gain) => void api.post(`/api/layers/${l}`, { gain })}
                />
                <span className="micro">{st.gain}</span>
                <button
                  className="btn mute"
                  aria-pressed={st.muted}
                  aria-label={`Mute ${l}`}
                  onClick={() => void api.post(`/api/layers/${l}`, { muted: !st.muted })}
                >
                  M
                </button>
              </div>
              <div
                className={`meter${duck < -0.5 ? ' hot' : ''}`}
                style={{ marginBottom: 6 }}
                aria-hidden="true"
              >
                <i style={{ width: `${Math.min(100, level * 600)}%` }} />
              </div>
            </div>
          );
        })}
        <div className="layer">
          <span className="label">Master</span>
          <Fader
            label="master"
            value={state.mixer.master}
            onChange={(gain) => void api.post('/api/master', { gain })}
          />
          <span className="micro">{state.mixer.master}</span>
          <span />
        </div>
        <div className={`meter${mixer?.limiting ? ' hot' : ''}`} aria-hidden="true">
          <i style={{ width: `${Math.min(100, (mixer?.masterLevel ?? 0) * 500)}%` }} />
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn small"
            aria-pressed={state.mixer.ducking.enabled}
            title="Dip the music while anyone speaks"
            onClick={() => void api.post('/api/ducking', { enabled: !state.mixer.ducking.enabled })}
          >
            Ducking {state.mixer.ducking.enabled ? 'on' : 'off'}
          </button>
          <select
            className="input"
            aria-label="Ducking depth"
            value={state.mixer.ducking.depthDb}
            onChange={(e) => void api.post('/api/ducking', { depthDb: Number(e.target.value) })}
          >
            {[-3, -6, -9, -12, -18].map((d) => (
              <option key={d} value={d}>
                {d} dB
              </option>
            ))}
          </select>
        </div>
      </div>
    </section>
  );
}
