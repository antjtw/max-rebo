import { formatDuration } from '@cantina/shared';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

export function NowPlaying() {
  const state = useStore((s) => s.state);
  if (!state) return null;
  const np = state.nowPlaying.music;
  const next = state.nowPlaying.next;
  const pct = np?.durationS ? Math.min(100, (np.positionS / np.durationS) * 100) : 0;
  return (
    <section className="panel" aria-labelledby="np-h">
      <h2 className="label" id="np-h">
        Now playing
        <span className="row">
          <span className="micro">Despair</span>
          <span
            className="diamonds"
            role="img"
            aria-label={`Despair pool ${state.game.despairPool}`}
          >
            {Array.from({ length: Math.max(5, state.game.despairPool) }, (_, i) => (
              <i key={i} className={i < state.game.despairPool ? 'on' : ''} />
            ))}
          </span>
        </span>
      </h2>
      <div className="np">
        <div>
          <div className="title">{np ? np.title : '—'}</div>
          <div className="micro">
            {np?.album ?? ''}{' '}
            {np ? `· ${formatDuration(np.positionS)} / ${formatDuration(np.durationS)}` : ''}
          </div>
        </div>
        <div className="row">
          <button
            className="btn small"
            onClick={() => void api.post('/api/music/pause', { paused: !state.mixer.paused })}
            title="Space"
          >
            {state.mixer.paused ? 'Resume' : 'Pause'}
          </button>
          <button className="btn small" onClick={() => void api.post('/api/music/next')} title="N">
            Next
          </button>
          {np && !np.trackId.startsWith('path:') ? (
            <>
              <button
                className="btn small"
                aria-label="Thumbs up"
                onClick={() =>
                  void api.post('/api/music/feedback', { trackId: np.trackId, vote: 'up' })
                }
              >
                ▲
              </button>
              <button
                className="btn small"
                aria-label="Thumbs down"
                onClick={() =>
                  void api.post('/api/music/feedback', { trackId: np.trackId, vote: 'down' })
                }
              >
                ▼
              </button>
            </>
          ) : null}
        </div>
        <div className="progress" style={{ gridColumn: '1 / -1' }} aria-hidden="true">
          <i style={{ width: `${pct}%` }} />
        </div>
        <div className="micro" style={{ gridColumn: '1 / -1' }}>
          Next: {next ? next.title : '—'}
          {state.nowPlaying.ambience.length
            ? ` · Ambience: ${state.nowPlaying.ambience.map((a) => a.title).join(', ')}`
            : ''}
        </div>
      </div>
    </section>
  );
}
