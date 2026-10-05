import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

/** MTFBWY controls (SPEC §9.6): Despair pool, the Focus, Dyad dice outcomes. */
export function GamePanel() {
  const state = useStore((s) => s.state);
  if (!state) return null;
  const g = state.game;
  const post = (url: string, body: unknown = {}) => void api.post(url, body);
  return (
    <section className="panel" aria-labelledby="game-h">
      <h2 className="label" id="game-h">
        Game <span className="micro">MTFBWY · tension {state.scene.tensionStep}</span>
      </h2>
      <div className="game-grid">
        <span className="micro">Despair</span>
        <div className="row wrap">
          <button
            className="btn small"
            aria-label="Despair plus one"
            onClick={() => post('/api/game/despair', { delta: 1 })}
          >
            +1
          </button>
          <button
            className="btn small"
            aria-label="Spend one Despair"
            onClick={() => post('/api/game/despair', { delta: -1 })}
          >
            Spend 1
          </button>
          <button
            className="btn small"
            aria-label="Spend three Despair to interrupt a Hero"
            onClick={() => post('/api/game/despair', { delta: -3 })}
          >
            Interrupt 3
          </button>
        </div>
        <span className="micro">Focus</span>
        <div className="seg" role="group" aria-label="Who has the Focus">
          <button
            className="btn small"
            aria-pressed={g.focus === 'heroes'}
            onClick={() => post('/api/game/focus', { holder: 'heroes' })}
          >
            Heroes
          </button>
          <button
            className="btn small"
            aria-pressed={g.focus === 'gm'}
            onClick={() => post('/api/game/focus', { holder: 'gm' })}
          >
            GM
          </button>
        </div>
        <span className="micro">Dyad</span>
        <div className="row wrap">
          <button
            className="btn small"
            title="Major crit"
            onClick={() => post('/api/game/roll', { balance: 12, despair: 12 })}
          >
            12·12
          </button>
          <button
            className="btn small"
            title="Major crit fail"
            onClick={() => post('/api/game/roll', { balance: 1, despair: 1 })}
          >
            1·1
          </button>
          <button
            className="btn small"
            title="Minor crit"
            onClick={() => post('/api/game/roll', { balance: 6, despair: 6 })}
          >
            Doubles
          </button>
          <button
            className="btn small"
            title="Scene concluded or full rest: shift towards calm"
            onClick={() => post('/api/game/conclude')}
          >
            Concluded
          </button>
        </div>
      </div>
    </section>
  );
}
