import { useMemo, useState } from 'react';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

export function previewInBrowser(trackId: string): void {
  // Ant's headphones only; never sent to Discord (SPEC §6.5).
  const audio = new Audio(`/api/media/${encodeURIComponent(trackId)}`);
  void audio.play().catch(() => undefined);
}

export function Soundboard() {
  const state = useStore((s) => s.state);
  const [tab, setTab] = useState<string>('all');
  const [cat, setCat] = useState<string>('');
  const [q, setQ] = useState('');
  const buttons = useMemo(() => {
    const all = state?.soundboard ?? [];
    return all.filter(
      (b) =>
        (tab === 'all' || (tab === 'generic' ? !b.playerId : b.playerId === tab)) &&
        (!cat || b.category === cat) &&
        (!q || b.label.toLowerCase().includes(q.toLowerCase())),
    );
  }, [state?.soundboard, tab, cat, q]);
  if (!state) return null;
  const cats = [...new Set(state.soundboard.map((b) => b.category).filter(Boolean))] as string[];
  const fire = (id: string) =>
    void api
      .post('/api/sfx/fire', { sfxId: id })
      .catch((e: Error) => useStore.getState().setToast(e.message, 'error'));
  return (
    <section className="panel soundboard" aria-labelledby="sb-h">
      <div className="row wrap">
        <h2 className="label" id="sb-h" style={{ margin: 0 }}>
          Soundboard
        </h2>
        <div className="sb-tabs" role="tablist" aria-label="Filter by player">
          {[
            ['all', 'All'],
            ['generic', 'Generic'],
            ...state.players.map((p) => [p.id, p.displayName]),
          ].map(([id, label]) => (
            <button
              key={id}
              role="tab"
              aria-selected={tab === id}
              className={`btn small${tab === id ? ' active' : ''}`}
              onClick={() => setTab(id!)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <select
          className="input"
          aria-label="Category"
          value={cat}
          onChange={(e) => setCat(e.target.value)}
        >
          <option value="">All categories</option>
          {cats.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </select>
        <input
          className="input"
          id="sb-search"
          placeholder="Search ( / )"
          aria-label="Search sounds"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="sb-grid">
        {buttons.length === 0 ? (
          <p className="empty">No sounds yet. Scan a library with SFX, or add triggers.</p>
        ) : null}
        {buttons.map((b) => (
          <button
            key={b.id}
            className="btn sb-btn"
            onClick={() => fire(b.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              if (!b.id.includes(':')) previewInBrowser(b.id);
            }}
            title={
              b.id.includes(':')
                ? 'Click to fire'
                : 'Click to fire · right-click to preview in your headphones'
            }
          >
            <span>
              {b.hotkey ? <span className="key">{b.hotkey}</span> : null}
              {b.label}
            </span>
            {b.character ? (
              <span className="who">{b.character}</span>
            ) : (
              <span className="micro">{b.category ?? ''}</span>
            )}
          </button>
        ))}
      </div>
    </section>
  );
}
