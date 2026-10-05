import { useEffect, useState } from 'react';
import type { Scene, ScenesFile } from '@cantina/shared';
import { YamlEditor } from '../components/YamlEditor.tsx';
import { api } from '../state/api.ts';
import { useConfig } from '../state/config.ts';

const SCENE_TAGS = [
  'calm',
  'exploration',
  'travel',
  'hyperspace',
  'cantina',
  'social',
  'mystery',
  'stealth',
  'tension',
  'chase',
  'combat',
  'boss',
  'dark-side',
  'force',
  'sorrow',
  'triumph',
  'horror',
  'montage',
];

function kwToText(kw: Record<string, number>): string {
  return Object.entries(kw)
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
function textToKw(t: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const line of t.split('\n')) {
    const m = /^(.*?):\s*(-?[\d.]+)\s*$/.exec(line.trim());
    if (m && m[1]) out[m[1].trim()] = Number(m[2]);
  }
  return out;
}

export function ScenesRoute() {
  const { value, save, errors, reload } = useConfig<ScenesFile>('scenes');
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Scene | null>(null);
  const [kwText, setKwText] = useState('');
  const [count, setCount] = useState<number | null>(null);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    const s = value?.scenes.find((x) => x.id === sel);
    setDraft(s ? structuredClone(s) : null);
    setKwText(s ? kwToText(s.entry.keywords) : '');
  }, [sel, value]);
  useEffect(() => {
    if (!draft) return;
    const t = setTimeout(
      () =>
        void api
          .post<{ count: number }>('/api/scenes/preview', { query: draft.music })
          .then((r) => setCount(r.count)),
      200,
    );
    return () => clearTimeout(t);
  }, [draft]);

  const commit = async () => {
    if (!value || !draft) return;
    const next = { ...draft, entry: { ...draft.entry, keywords: textToKw(kwText) } };
    await save({ scenes: value.scenes.map((s) => (s.id === sel ? next : s)) });
  };
  const toggleTag = (tag: string) => {
    if (!draft) return;
    const cur = new Set(draft.music.scenes ?? []);
    if (cur.has(tag)) cur.delete(tag);
    else cur.add(tag);
    setDraft({ ...draft, music: { ...draft.music, scenes: [...cur] } });
  };
  const range = draft?.music.intensity ?? [1, 5];

  return (
    <main className="screen">
      <div className="screen-grid" style={{ gridTemplateColumns: '240px 1fr' }}>
        <section className="panel" aria-label="Scenes">
          <h2 className="label">
            Scenes
            <button className="btn small" aria-pressed={raw} onClick={() => setRaw(!raw)}>
              YAML
            </button>
          </h2>
          {value?.scenes.map((s, i) => (
            <button
              key={s.id}
              className="btn"
              style={{ width: '100%', marginBottom: 4, textAlign: 'left' }}
              aria-pressed={s.id === sel}
              onClick={() => setSel(s.id)}
            >
              {i + 1}. {s.label} {s.manualOnly ? <span className="micro">manual</span> : null}
            </button>
          ))}
        </section>
        <section className="panel" aria-label="Scene editor">
          {raw ? (
            <YamlEditor name="scenes" rows={30} onSaved={reload} />
          ) : draft ? (
            <>
              <h2 className="label">
                {draft.label}{' '}
                <span className="micro">{count == null ? '' : `${count} matching track(s)`}</span>
              </h2>
              <div className="screen-grid">
                <div>
                  <label className="field">
                    <span className="micro">Label</span>
                    <input
                      className="input"
                      value={draft.label}
                      onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                    />
                  </label>
                  <div className="micro">Music: scene tags</div>
                  <div style={{ margin: '4px 0 8px' }}>
                    {SCENE_TAGS.map((t) => (
                      <button
                        key={t}
                        className={`chip ${draft.music.scenes?.includes(t) ? 'confirmed' : 'inferred'}`}
                        aria-pressed={!!draft.music.scenes?.includes(t)}
                        onClick={() => toggleTag(t)}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                  <div className="row">
                    <label className="field">
                      <span className="micro">Intensity min</span>
                      <select
                        className="input"
                        value={range[0]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            music: {
                              ...draft.music,
                              intensity: [
                                Number(e.target.value),
                                Math.max(Number(e.target.value), range[1]),
                              ],
                            },
                          })
                        }
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      <span className="micro">Intensity max</span>
                      <select
                        className="input"
                        value={range[1]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            music: {
                              ...draft.music,
                              intensity: [
                                Math.min(range[0], Number(e.target.value)),
                                Number(e.target.value),
                              ],
                            },
                          })
                        }
                      >
                        {[1, 2, 3, 4, 5].map((n) => (
                          <option key={n}>{n}</option>
                        ))}
                      </select>
                    </label>
                    <label className="row" style={{ marginTop: 14 }}>
                      <input
                        type="checkbox"
                        checked={
                          !(draft.music.vocals ?? []).includes('lyrics') &&
                          (draft.music.vocals?.length ?? 0) > 0
                        }
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            music: {
                              ...draft.music,
                              vocals: e.target.checked ? ['none'] : undefined,
                            },
                          })
                        }
                      />
                      Instrumental only
                    </label>
                  </div>
                  <label className="field">
                    <span className="micro">
                      Explicit tracks (one path per line; overrides tags)
                    </span>
                    <textarea
                      className="input"
                      rows={3}
                      value={(draft.music.tracks ?? []).join('\n')}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          music: {
                            ...draft.music,
                            tracks: e.target.value.split('\n').filter((l) => l.trim()),
                          },
                        })
                      }
                    />
                  </label>
                </div>
                <div>
                  <label className="field">
                    <span className="micro">Entry keywords (phrase: weight)</span>
                    <textarea
                      className="input"
                      rows={7}
                      value={kwText}
                      onChange={(e) => setKwText(e.target.value)}
                    />
                  </label>
                  <div className="row">
                    <label className="field">
                      <span className="micro">Crossfade (s)</span>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        step={0.5}
                        value={draft.crossfadeS ?? ''}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            crossfadeS: e.target.value === '' ? undefined : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label className="field">
                      <span className="micro">Min dwell (s)</span>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        value={draft.minDwellS}
                        onChange={(e) => setDraft({ ...draft, minDwellS: Number(e.target.value) })}
                      />
                    </label>
                    <label className="field">
                      <span className="micro">Priority</span>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={100}
                        value={draft.priority}
                        onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={draft.manualOnly}
                      onChange={(e) => setDraft({ ...draft, manualOnly: e.target.checked })}
                    />{' '}
                    Manual only (never chosen automatically)
                  </label>
                </div>
              </div>
              {errors.length ? <div className="errors">{errors.join('\n')}</div> : null}
              <button
                className="btn primary small"
                style={{ marginTop: 8 }}
                onClick={() => void commit()}
              >
                Save scene
              </button>
            </>
          ) : (
            <p className="empty">Choose a scene.</p>
          )}
        </section>
      </div>
    </main>
  );
}
