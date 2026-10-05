import { useEffect, useState } from 'react';
import type { Trigger, TriggersFile } from '@cantina/shared';
import { YamlEditor } from '../components/YamlEditor.tsx';
import { api } from '../state/api.ts';
import { useConfig } from '../state/config.ts';
import { useStore } from '../state/store.ts';

interface Decision {
  triggerId: string;
  phrase: string;
  score: number;
  confidence: number;
  subject: string | null;
  fired: boolean;
  reason: string | null;
}

export function TriggersRoute() {
  const { value, save, errors, reload } = useConfig<TriggersFile>('triggers');
  const state = useStore((s) => s.state);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Trigger | null>(null);
  const [text, setText] = useState('I ignite my lightsaber');
  const [speaker, setSpeaker] = useState('');
  const [results, setResults] = useState<Decision[]>([]);
  const [raw, setRaw] = useState(false);

  useEffect(() => {
    const t = value?.triggers.find((x) => x.id === sel) ?? null;
    setDraft(t ? structuredClone(t) : null);
  }, [sel, value]);
  useEffect(() => {
    if (!speaker && state?.players[0]) setSpeaker(state.players[0].id);
  }, [state?.players, speaker]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (text.trim())
        void api
          .post<Decision[]>('/api/triggers/test', { text, playerId: speaker || undefined })
          .then(setResults);
      else setResults([]);
    }, 150);
    return () => clearTimeout(t);
  }, [text, speaker, value]);

  const commit = async () => {
    if (!value || !draft) return;
    const triggers = value.triggers.map((t) => (t.id === sel ? draft : t));
    if (await save({ ...value, triggers })) setSel(draft.id);
  };
  const add = async () => {
    if (!value) return;
    const id = `new-trigger-${value.triggers.length + 1}`;
    if (
      await save({
        ...value,
        triggers: [
          ...value.triggers,
          { id, label: 'New trigger', phrases: ['[i] do the thing'], enabled: true } as Trigger,
        ],
      })
    )
      setSel(id);
  };
  const soundCat = draft && typeof draft.sound === 'object' ? draft.sound : null;

  return (
    <main className="screen">
      <div className="screen-grid">
        <section className="panel" aria-label="Phrase tester">
          <h2 className="label">Phrase tester</h2>
          <div className="row">
            <select
              className="input"
              aria-label="Speaker"
              value={speaker}
              onChange={(e) => setSpeaker(e.target.value)}
            >
              {state?.players.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
            <input
              className="input"
              style={{ flex: 1 }}
              aria-label="Phrase to test"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>
          <table className="grid" style={{ marginTop: 8 }}>
            <thead>
              <tr>
                <th>Trigger</th>
                <th>Score</th>
                <th>Subject</th>
                <th>Result</th>
              </tr>
            </thead>
            <tbody>
              {results.length === 0 ? (
                <tr>
                  <td colSpan={4} className="dim">
                    No matches.
                  </td>
                </tr>
              ) : (
                results.map((r) => (
                  <tr key={r.triggerId}>
                    <td>{r.triggerId}</td>
                    <td>{Math.round(r.score * 100)}%</td>
                    <td>{r.subject ?? '—'}</td>
                    <td className={r.fired ? 'signal' : 'dim'}>
                      {r.fired ? 'FIRES' : `suppressed: ${r.reason}`}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section>
        <section className="panel" aria-label="Triggers">
          <h2 className="label">
            Triggers
            <span className="row">
              <button className="btn small" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                YAML
              </button>
              <button className="btn small" onClick={() => void add()}>
                Add
              </button>
            </span>
          </h2>
          {raw ? (
            <YamlEditor name="triggers" rows={24} onSaved={reload} />
          ) : (
            <div className="row wrap">
              {value?.triggers.map((t) => (
                <button
                  key={t.id}
                  className="btn small"
                  aria-pressed={t.id === sel}
                  onClick={() => setSel(t.id)}
                >
                  {t.enabled ? '' : '○ '}
                  {t.label ?? t.id}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      {draft && !raw ? (
        <section
          className="panel"
          style={{ marginTop: 'var(--gap)' }}
          aria-label={`Edit ${draft.id}`}
        >
          <h2 className="label">Edit · {draft.id}</h2>
          <div className="screen-grid">
            <div>
              <label className="field">
                <span className="micro">Label</span>
                <input
                  className="input"
                  value={draft.label ?? ''}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                />
              </label>
              <label className="field">
                <span className="micro">
                  Phrases (one per line) · (a|b) alternatives · [opt] optional · {'{character}'}{' '}
                  {'{player}'} {'{number}'}
                </span>
                <textarea
                  className="input"
                  rows={5}
                  value={draft.phrases.join('\n')}
                  onChange={(e) =>
                    setDraft({
                      ...draft,
                      phrases: e.target.value.split('\n').filter((l) => l.trim()),
                    })
                  }
                />
              </label>
              <div className="row wrap">
                <label className="row">
                  <input
                    type="checkbox"
                    checked={draft.enabled}
                    onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                  />{' '}
                  Enabled
                </label>
                <label className="row">
                  <input
                    type="checkbox"
                    checked={draft.ignoreQuestions}
                    onChange={(e) => setDraft({ ...draft, ignoreQuestions: e.target.checked })}
                  />{' '}
                  Ignore questions
                </label>
                <label className="row">
                  Subject
                  <select
                    className="input"
                    value={draft.subject}
                    onChange={(e) =>
                      setDraft({ ...draft, subject: e.target.value as Trigger['subject'] })
                    }
                  >
                    <option value="auto">auto</option>
                    <option value="speaker">speaker</option>
                    <option value="none">none</option>
                  </select>
                </label>
              </div>
            </div>
            <div>
              <div className="row">
                <label className="field" style={{ flex: 1 }}>
                  <span className="micro">Sound category</span>
                  <input
                    className="input"
                    value={soundCat?.category ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        sound: { ...(soundCat ?? {}), category: e.target.value || undefined },
                      })
                    }
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span className="micro">Phase</span>
                  <input
                    className="input"
                    value={soundCat?.phase ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        sound: { ...(soundCat ?? {}), phase: e.target.value || undefined },
                      })
                    }
                  />
                </label>
              </div>
              <label className="field">
                <span className="micro">…or a specific file (relative to a library root)</span>
                <input
                  className="input"
                  value={typeof draft.sound === 'string' ? draft.sound : ''}
                  onChange={(e) =>
                    setDraft({ ...draft, sound: e.target.value || soundCat || undefined })
                  }
                />
              </label>
              <div className="row">
                <label className="field" style={{ flex: 1 }}>
                  <span className="micro">Cooldown (s)</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    step={0.5}
                    value={draft.cooldownS ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        cooldownS: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span className="micro">Min confidence</span>
                  <input
                    className="input"
                    type="number"
                    min={0}
                    max={1}
                    step={0.05}
                    value={draft.minConfidence ?? ''}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        minConfidence: e.target.value === '' ? undefined : Number(e.target.value),
                      })
                    }
                  />
                </label>
                <label className="field" style={{ flex: 1 }}>
                  <span className="micro">Gain (dB)</span>
                  <input
                    className="input"
                    type="number"
                    step={1}
                    value={draft.gainDb}
                    onChange={(e) => setDraft({ ...draft, gainDb: Number(e.target.value) })}
                  />
                </label>
              </div>
            </div>
          </div>
          {errors.length ? <div className="errors">{errors.join('\n')}</div> : null}
          <div className="row">
            <button className="btn primary small" onClick={() => void commit()}>
              Save trigger
            </button>
            <button
              className="btn small"
              onClick={() =>
                void api
                  .post('/api/sfx/fire', { triggerId: draft.id })
                  .catch((e: Error) => useStore.getState().setToast(e.message, 'error'))
              }
            >
              Test sound
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
