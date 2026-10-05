import { useEffect, useMemo, useState } from 'react';
import type { Player, PlayersFile, TrackSummary, TriggersFile } from '@cantina/shared';
import { YamlEditor } from '../components/YamlEditor.tsx';
import { api } from '../state/api.ts';
import { useConfig } from '../state/config.ts';
import { useStore } from '../state/store.ts';

export function PlayersRoute() {
  const { value, save, errors, reload } = useConfig<PlayersFile>('players');
  const triggers = useConfig<TriggersFile>('triggers').value;
  const state = useStore((s) => s.state);
  const [sel, setSel] = useState<string | null>(null);
  const [draft, setDraft] = useState<Player | null>(null);
  const [sfx, setSfx] = useState<TrackSummary[]>([]);
  const [q, setQ] = useState('');
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    const p = value?.players.find((x) => x.id === sel);
    setDraft(p ? structuredClone(p) : null);
  }, [sel, value]);
  useEffect(() => {
    void api
      .get<{ rows: TrackSummary[] }>(
        `/api/library?kind=sfx&limit=1000${q ? `&q=${encodeURIComponent(q)}` : ''}`,
      )
      .then((r) => setSfx(r.rows));
  }, [q]);
  const members = useMemo(
    () => state?.voice.channels.flatMap((c) => c.members.filter((m) => !m.bot)) ?? [],
    [state?.voice.channels],
  );

  const commit = async () => {
    if (!value || !draft) return;
    const players = value.players.some((p) => p.id === sel)
      ? value.players.map((p) => (p.id === sel ? draft : p))
      : [...value.players, draft];
    if (await save({ players })) setSel(draft.id);
  };
  const add = () => {
    const id = `player-${(value?.players.length ?? 0) + 1}`;
    setSel(id);
    setDraft({ id, displayName: 'New player', aliases: [], role: 'player', sfx: {} });
  };
  const setOverride = (key: string, path: string) =>
    draft && setDraft({ ...draft, sfx: { ...draft.sfx, ...(path ? { [key]: path } : {}) } });
  const clearOverride = (key: string) => {
    if (!draft) return;
    const n = { ...draft.sfx };
    delete n[key];
    setDraft({ ...draft, sfx: n });
  };
  const slots = (triggers?.triggers ?? []).flatMap((t) => [
    t.id,
    ...(t.loop ? [`${t.id}.loop`] : []),
  ]);

  return (
    <main className="screen">
      <div className="screen-grid" style={{ gridTemplateColumns: '260px 1fr 320px' }}>
        <section className="panel" aria-label="Players">
          <h2 className="label">
            Players
            <span className="row">
              <button className="btn small" aria-pressed={raw} onClick={() => setRaw(!raw)}>
                YAML
              </button>
              <button className="btn small" onClick={add}>
                Add
              </button>
            </span>
          </h2>
          {value?.players.map((p) => (
            <button
              key={p.id}
              className="btn"
              style={{ width: '100%', marginBottom: 4, textAlign: 'left' }}
              aria-pressed={p.id === sel}
              onClick={() => setSel(p.id)}
            >
              {p.displayName} {p.character ? <span className="micro">· {p.character}</span> : null}{' '}
              {p.role === 'gm' ? <span className="micro signal">GM</span> : null}
            </button>
          ))}
          {value && value.players.length === 0 ? (
            <p className="empty">
              No players yet. players.yaml is gitignored because it holds Discord IDs.
            </p>
          ) : null}
        </section>
        <section className="panel" aria-label="Player profile">
          {raw ? (
            <YamlEditor name="players" rows={26} onSaved={reload} />
          ) : draft ? (
            <>
              <h2 className="label">{draft.displayName}</h2>
              <div className="screen-grid">
                <label className="field">
                  <span className="micro">Display name</span>
                  <input
                    className="input"
                    value={draft.displayName}
                    onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                  />
                </label>
                <label className="field">
                  <span className="micro">Id</span>
                  <input
                    className="input"
                    value={draft.id}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        id: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span className="micro">Character</span>
                  <input
                    className="input"
                    value={draft.character ?? ''}
                    onChange={(e) => setDraft({ ...draft, character: e.target.value || undefined })}
                  />
                </label>
                <label className="field">
                  <span className="micro">Aliases (comma separated)</span>
                  <input
                    className="input"
                    value={draft.aliases.join(', ')}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        aliases: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
                <label className="field">
                  <span className="micro">Discord user</span>
                  <select
                    className="input"
                    value={draft.discordUserId ?? ''}
                    onChange={(e) =>
                      setDraft({ ...draft, discordUserId: e.target.value || undefined })
                    }
                  >
                    <option value="">—</option>
                    {draft.discordUserId &&
                    !members.some((m) => m.userId === draft.discordUserId) ? (
                      <option value={draft.discordUserId}>{draft.discordUserId}</option>
                    ) : null}
                    {members.map((m) => (
                      <option key={m.userId} value={m.userId}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="micro">Role</span>
                  <select
                    className="input"
                    value={draft.role}
                    onChange={(e) => setDraft({ ...draft, role: e.target.value as Player['role'] })}
                  >
                    <option value="player">player</option>
                    <option value="gm">gm</option>
                  </select>
                </label>
              </div>
              <h3 className="label" style={{ marginTop: 8 }}>
                Personal SFX <span className="micro">drag a sound onto a slot</span>
              </h3>
              <table className="grid">
                <tbody>
                  {slots.map((slot) => (
                    <tr
                      key={slot}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const p = e.dataTransfer.getData('text/plain');
                        if (p) setOverride(slot, p);
                      }}
                    >
                      <td style={{ width: 160 }}>{slot}</td>
                      <td>
                        <input
                          className="input"
                          style={{ width: '100%' }}
                          aria-label={`${slot} sound`}
                          placeholder="generic sound"
                          value={draft.sfx[slot] ?? ''}
                          onChange={(e) =>
                            e.target.value ? setOverride(slot, e.target.value) : clearOverride(slot)
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {errors.length ? <div className="errors">{errors.join('\n')}</div> : null}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary small" onClick={() => void commit()}>
                  Save player
                </button>
                <button
                  className="btn small danger"
                  onClick={() => {
                    if (value && confirm(`Remove ${draft.displayName}?`))
                      void save({ players: value.players.filter((p) => p.id !== sel) }).then(() =>
                        setSel(null),
                      );
                  }}
                >
                  Remove
                </button>
              </div>
            </>
          ) : (
            <p className="empty">Choose a player.</p>
          )}
        </section>
        <section className="panel" aria-label="Sound effects library">
          <h2 className="label">SFX library</h2>
          <input
            className="input"
            placeholder="Search SFX"
            aria-label="Search SFX"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <ul className="panel-body" style={{ listStyle: 'none', padding: 0, marginTop: 8 }}>
            {sfx.map((t) => (
              <li
                key={t.id}
                draggable
                onDragStart={(e) => e.dataTransfer.setData('text/plain', t.relPath)}
                style={{
                  padding: '4px 6px',
                  border: '1px solid var(--line-faint)',
                  marginBottom: 3,
                  cursor: 'grab',
                }}
                title={t.relPath}
              >
                {t.title}
                <div className="micro">{t.relPath}</div>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </main>
  );
}
