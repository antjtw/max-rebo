import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TagRow, TrackSummary } from '@cantina/shared';
import { formatDuration } from '@cantina/shared';
import { previewInBrowser } from '../panels/Soundboard.tsx';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

const ROW_H = 34;
const FACETS = ['scenes', 'moods', 'settings', 'factions', 'category', 'phase', 'tags'] as const;

interface HealthRow {
  sceneId: string;
  label: string;
  confirmed: number;
  inferred: number;
  message: string | null;
}

function statusOf(t: TrackSummary): 'confirmed' | 'inferred' | 'untagged' {
  if (t.tags.some((x) => x.status === 'inferred')) return 'inferred';
  if (t.tags.some((x) => x.status === 'confirmed')) return 'confirmed';
  return 'untagged';
}

function conf(t: TrackSummary): number | null {
  const inf = t.tags.filter((x) => x.status !== 'rejected');
  if (!inf.length) return null;
  return inf.reduce((a, x) => a + x.confidence, 0) / inf.length;
}

export function LibraryRoute() {
  const [rows, setRows] = useState<TrackSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [status, setStatus] = useState('');
  const [facet, setFacet] = useState('');
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [health, setHealth] = useState<HealthRow[]>([]);
  const [view, setView] = useState<'tracks' | 'health'>('tracks');
  const scan = useStore((s) => s.scanProgress);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(600);

  const load = useCallback(() => {
    const p = new URLSearchParams({ limit: '5000' });
    if (q) p.set('q', q);
    if (kind) p.set('kind', kind);
    if (status) p.set('status', status);
    if (facet && value) {
      p.set('facet', facet);
      p.set('value', value);
    }
    void api.get<{ total: number; rows: TrackSummary[] }>(`/api/library?${p}`).then((r) => {
      setRows(r.rows);
      setTotal(r.total);
    });
    void api.get<HealthRow[]>('/api/library/health').then(setHealth);
  }, [q, kind, status, facet, value]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  useEffect(() => {
    if (!scan) load();
  }, [scan, load]);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [view]);

  const track = rows.find((r) => r.id === selected) ?? null;
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - 5);
  const visible = rows.slice(first, first + Math.ceil(height / ROW_H) + 10);
  const updateRow = (t: TrackSummary) => setRows((rs) => rs.map((r) => (r.id === t.id ? t : r)));
  const inferredIds = useMemo(
    () => rows.filter((r) => statusOf(r) === 'inferred').map((r) => r.id),
    [rows],
  );
  const bulkIds = checked.size ? [...checked] : inferredIds;

  return (
    <main
      className="screen"
      style={{
        display: 'grid',
        gridTemplateColumns: track ? '1fr 380px' : '1fr',
        gap: 'var(--gap)',
        height: '100%',
      }}
    >
      <section className="panel" style={{ minHeight: 0 }} aria-label="Library">
        <div className="row wrap" style={{ marginBottom: 8 }}>
          <div className="seg">
            <button
              className="btn small"
              aria-pressed={view === 'tracks'}
              onClick={() => setView('tracks')}
            >
              Tracks ({total})
            </button>
            <button
              className="btn small"
              aria-pressed={view === 'health'}
              onClick={() => setView('health')}
            >
              Library health
            </button>
          </div>
          <input
            className="input"
            placeholder="Search"
            aria-label="Search library"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <select
            className="input"
            aria-label="Kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">All kinds</option>
            {['music', 'ambience', 'sfx', 'sting'].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
          <select
            className="input"
            aria-label="Status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any status</option>
            <option value="needs_review">Needs review</option>
            <option value="confirmed">Confirmed</option>
          </select>
          <select
            className="input"
            aria-label="Facet"
            value={facet}
            onChange={(e) => setFacet(e.target.value)}
          >
            <option value="">Any tag</option>
            {FACETS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          {facet ? (
            <input
              className="input"
              placeholder="value, e.g. combat"
              aria-label="Tag value"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          ) : null}
          <span className="spacer" />
          <button className="btn small" onClick={() => void api.post('/api/library/scan')}>
            Scan
          </button>
          <button className="btn small" onClick={() => void api.post('/api/library/analyse')}>
            Analyse
          </button>
          <button
            className="btn small primary"
            disabled={!bulkIds.length}
            onClick={() =>
              void api.post('/api/library/confirm', { trackIds: bulkIds }).then(() => {
                setChecked(new Set());
                load();
              })
            }
          >
            Confirm{' '}
            {checked.size ? `${checked.size} selected` : `all inferred (${inferredIds.length})`}
          </button>
        </div>
        {scan ? (
          <div className="micro" role="status">
            {scan.phase} {Math.round(scan.progress * 100)}% {scan.message ?? ''}
            <div className="progress">
              <i style={{ width: `${scan.progress * 100}%` }} />
            </div>
          </div>
        ) : null}
        {view === 'health' ? (
          <table className="grid">
            <thead>
              <tr>
                <th>Scene</th>
                <th>Confirmed</th>
                <th>Inferred</th>
                <th>Gap</th>
              </tr>
            </thead>
            <tbody>
              {health.map((h) => (
                <tr key={h.sceneId}>
                  <td>{h.label}</td>
                  <td>{h.confirmed}</td>
                  <td>{h.inferred}</td>
                  <td className={h.message ? 'signal' : 'dim'}>{h.message ?? 'OK'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div
            ref={scrollRef}
            className="panel-body"
            style={{ position: 'relative' }}
            onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
          >
            {rows.length === 0 ? (
              <p className="empty">No tracks. Set CANTINA_LIBRARY_PATHS in .env and press Scan.</p>
            ) : null}
            <table className="grid" style={{ tableLayout: 'fixed' }}>
              <thead>
                <tr>
                  <th style={{ width: 28 }}>
                    <span className="sr-only">Select</span>
                  </th>
                  <th>Title</th>
                  <th>Album</th>
                  <th style={{ width: 80 }}>Kind</th>
                  <th>Scenes</th>
                  <th>Moods</th>
                  <th style={{ width: 40 }}>Int</th>
                  <th style={{ width: 90 }}>Status</th>
                  <th style={{ width: 50 }}>Conf</th>
                </tr>
              </thead>
              <tbody>
                <tr style={{ height: first * ROW_H }} aria-hidden="true" />
                {visible.map((t) => {
                  const st = statusOf(t);
                  const c = conf(t);
                  const vals = (f: string) =>
                    t.tags
                      .filter((x) => x.facet === f && x.status !== 'rejected')
                      .map((x) => x.value)
                      .join(', ');
                  return (
                    <tr
                      key={t.id}
                      style={{ height: ROW_H, cursor: 'pointer' }}
                      className={t.id === selected ? 'selected' : ''}
                      onClick={() => setSelected(t.id)}
                    >
                      <td onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          aria-label={`Select ${t.title}`}
                          checked={checked.has(t.id)}
                          onChange={(e) => {
                            const n = new Set(checked);
                            if (e.target.checked) n.add(t.id);
                            else n.delete(t.id);
                            setChecked(n);
                          }}
                        />
                      </td>
                      <td
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t.missing ? <span className="signal">✕ </span> : null}
                        {t.title}
                      </td>
                      <td
                        className="dim"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {t.album ?? ''}
                      </td>
                      <td>{t.kind}</td>
                      <td
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {vals('scenes')}
                      </td>
                      <td
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {vals('moods')}
                      </td>
                      <td>{t.intensity ?? ''}</td>
                      <td className={st === 'inferred' ? 'signal' : st === 'untagged' ? 'dim' : ''}>
                        {st === 'inferred' ? 'review' : st}
                      </td>
                      <td className="dim">{c != null ? `${Math.round(c * 100)}%` : ''}</td>
                    </tr>
                  );
                })}
                <tr
                  style={{ height: Math.max(0, (rows.length - first - visible.length) * ROW_H) }}
                  aria-hidden="true"
                />
              </tbody>
            </table>
          </div>
        )}
      </section>
      {track ? (
        <TrackDetail
          key={track.id}
          track={track}
          onChange={updateRow}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </main>
  );
}

function TrackDetail({
  track,
  onChange,
  onClose,
}: {
  track: TrackSummary;
  onChange: (t: TrackSummary) => void;
  onClose: () => void;
}) {
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [newFacet, setNewFacet] = useState<string>('scenes');
  const [newValue, setNewValue] = useState('');
  useEffect(() => {
    void api
      .get<{ peaks: number[] }>(`/api/library/${track.id}/waveform`)
      .then((r) => setPeaks(r.peaks))
      .catch(() => setPeaks(null));
  }, [track.id]);
  const patch = (body: unknown) =>
    void api.patch<TrackSummary>(`/api/library/${track.id}`, body).then(onChange);
  const setTag = (t: Pick<TagRow, 'facet' | 'value'>, status: 'confirmed' | 'rejected') =>
    patch({ setTags: [{ facet: t.facet, value: t.value, status }] });
  const byFacet = FACETS.map((f) => [f, track.tags.filter((t) => t.facet === f)] as const).filter(
    ([, ts]) => ts.length,
  );
  return (
    <aside className="panel" aria-label={`Track ${track.title}`} style={{ minHeight: 0 }}>
      <h2 className="label">
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{track.title}</span>
        <button className="btn small" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </h2>
      <div className="panel-body">
        <div className="micro">{track.relPath}</div>
        <div className="micro">
          {track.album ?? ''} · {formatDuration(track.durationS)}
          {track.lufs != null
            ? ` · ${track.lufs.toFixed(1)} LUFS · gain ${track.gainDb?.toFixed(1)} dB`
            : ' · not analysed'}
        </div>
        {peaks ? (
          <svg
            viewBox={`0 0 ${peaks.length} 40`}
            preserveAspectRatio="none"
            style={{ width: '100%', height: 40, margin: '8px 0' }}
            aria-hidden="true"
          >
            {peaks.map((p, i) => (
              <line
                key={i}
                x1={i + 0.5}
                x2={i + 0.5}
                y1={20 - (p / 255) * 19}
                y2={20 + (p / 255) * 19}
                stroke="var(--line-dim)"
              />
            ))}
          </svg>
        ) : null}
        <div className="row" style={{ margin: '8px 0' }}>
          <button className="btn small" onClick={() => previewInBrowser(track.id)}>
            Preview (headphones)
          </button>
          {track.kind === 'music' ? (
            <button
              className="btn small"
              onClick={() => void api.post('/api/music/play', { trackId: track.id })}
            >
              Play now
            </button>
          ) : (
            <button
              className="btn small"
              onClick={() => void api.post('/api/sfx/fire', { sfxId: track.id })}
            >
              Fire
            </button>
          )}
          {track.kind === 'music' ? (
            <button
              className="btn small"
              onClick={() => void api.post('/api/music/queue', { trackId: track.id })}
            >
              Queue next
            </button>
          ) : null}
        </div>
        <div className="screen-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr' }}>
          <label className="field">
            <span className="micro">Kind</span>
            <select
              className="input"
              value={track.kind}
              onChange={(e) => patch({ kind: e.target.value })}
            >
              {['music', 'ambience', 'sfx', 'sting'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="micro">Intensity</span>
            <select
              className="input"
              value={track.intensity ?? ''}
              onChange={(e) => patch({ intensity: e.target.value ? Number(e.target.value) : null })}
            >
              <option value="">—</option>
              {[1, 2, 3, 4, 5].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="micro">Vocals</span>
            <select
              className="input"
              value={track.vocals ?? ''}
              onChange={(e) => patch({ vocals: e.target.value || null })}
            >
              <option value="">—</option>
              {['none', 'choir', 'lyrics'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
          </label>
        </div>
        {byFacet.map(([f, ts]) => (
          <div key={f} style={{ marginBottom: 6 }}>
            <div className="micro">{f}</div>
            {ts.map((t) => (
              <span
                key={t.value}
                className={`chip ${t.status}`}
                title={`${t.source} · ${Math.round(t.confidence * 100)}% · ${t.status}`}
              >
                {t.value}
                {t.status !== 'confirmed' ? (
                  <button
                    className="btn small"
                    style={{ padding: '0 4px', minHeight: 18 }}
                    aria-label={`Confirm ${t.value}`}
                    onClick={() => setTag(t, 'confirmed')}
                  >
                    ✓
                  </button>
                ) : null}
                {t.status !== 'rejected' ? (
                  <button
                    className="btn small"
                    style={{ padding: '0 4px', minHeight: 18 }}
                    aria-label={`Reject ${t.value}`}
                    onClick={() => setTag(t, 'rejected')}
                  >
                    ✕
                  </button>
                ) : null}
              </span>
            ))}
          </div>
        ))}
        <div className="row" style={{ margin: '8px 0' }}>
          <select
            className="input"
            aria-label="Facet"
            value={newFacet}
            onChange={(e) => setNewFacet(e.target.value)}
          >
            {FACETS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </select>
          <input
            className="input"
            aria-label="New tag"
            placeholder="add tag"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
          />
          <button
            className="btn small"
            disabled={!newValue.trim()}
            onClick={() => {
              setTag({ facet: newFacet, value: newValue.trim() }, 'confirmed');
              setNewValue('');
            }}
          >
            Add
          </button>
        </div>
        <button className="btn small primary" onClick={() => patch({ confirmAllInferred: true })}>
          Confirm all inferred
        </button>
        {track.rationale ? (
          <p className="micro" style={{ textTransform: 'none', letterSpacing: 0 }}>
            Rationale: {track.rationale}
          </p>
        ) : null}
      </div>
    </aside>
  );
}
