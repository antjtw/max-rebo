import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

const TRIGGER_WORDS =
  /\b(ignite[sd]?|activate[sd]?|deactivate[sd]?|retract[sd]?|light ?sab(?:er|re)|sab(?:er|re)|blaster|fire[sd]?|hyperspace|hyperdrive|punch it|ambush|despair|focus)\b/gi;

function highlight(text: string) {
  const parts: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TRIGGER_WORDS)) {
    if (m.index! > last) parts.push(text.slice(last, m.index));
    parts.push(<mark key={m.index}>{m[0]}</mark>);
    last = m.index! + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

/** Live transcript (SPEC §12.7). Memory only; cleared with one click. */
export function TranscriptPanel() {
  const lines = useStore((s) => s.transcript);
  const state = useStore((s) => s.state);
  const ref = useRef<HTMLDivElement>(null);
  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of state?.players ?? []) {
      if (p.userId) m.set(p.userId, p.displayName);
      m.set(p.id, p.displayName);
    }
    return m;
  }, [state?.players]);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines.length]);
  return (
    <section className="panel" aria-labelledby="tr-h">
      <h2 className="label" id="tr-h">
        Transcript
        <span className="row">
          <span className="micro">Memory only</span>
          <button
            className="btn small"
            onClick={() => {
              useStore.getState().clearTranscript();
              void api.del('/api/transcripts');
            }}
          >
            Clear
          </button>
        </span>
      </h2>
      <div className="panel-body" ref={ref} aria-live="polite">
        {lines.length === 0 ? (
          <p className="empty">
            {state?.listening.enabled ? 'Listening… nothing said yet.' : 'Listening is off.'}
          </p>
        ) : null}
        <ul className="transcript">
          {lines.map((l) => (
            <li key={l.utteranceId} className={l.final ? '' : 'partial'}>
              <span className="who">{names.get(l.userId) ?? l.userId}</span>
              {highlight(l.text)}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
