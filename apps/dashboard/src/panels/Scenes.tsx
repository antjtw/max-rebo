import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

export function ScenesPanel() {
  const state = useStore((s) => s.state);
  const scores = useStore((s) => s.scores);
  const threshold = 6;
  if (!state) return null;
  return (
    <section className="panel" aria-labelledby="scenes-h">
      <h2 className="label" id="scenes-h">
        Scenes <span className="micro">1–9</span>
      </h2>
      <ul className="scene-list panel-body">
        {state.scene.scenes.map((s, i) => {
          const active = s.id === state.scene.current;
          const score = scores[s.id] ?? s.score;
          return (
            <li key={s.id}>
              <button
                className="scene-btn"
                aria-current={active ? 'true' : undefined}
                onClick={() => void api.post('/api/scene', { sceneId: s.id })}
              >
                <span className="num">{i < 9 ? i + 1 : ''}</span>
                <span className="label">{s.label}</span>
                <span className="state micro">
                  {active ? 'ACTIVE' : s.manualOnly ? 'MANUAL' : ''}
                </span>
                <span
                  className={`score${score >= threshold ? ' hot' : ''}`}
                  style={{ width: `${Math.min(100, (score / (threshold * 2)) * 100)}%` }}
                  aria-hidden="true"
                />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
