import { useStore } from '../state/store.ts';

export function EventLog() {
  const log = useStore((s) => s.log);
  return (
    <section className="panel" aria-labelledby="log-h">
      <h2 className="label" id="log-h">
        Event log
      </h2>
      <div className="panel-body">
        {log.length === 0 ? <p className="empty">No events yet.</p> : null}
        <ul className="eventlog">
          {log.map((e) => (
            <li key={e.id} className={`k-${e.kind}`}>
              <span className="t">
                {new Date(e.ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span>{e.text}</span>
              <span className="lat">
                {e.latencyMs != null ? `${Math.round(e.latencyMs)} ms` : ''}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
