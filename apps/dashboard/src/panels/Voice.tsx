import { useEffect, useRef, useState } from 'react';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

/** Compact Join control for the header (SPEC §5.2): voice channels with their occupants. */
export function VoiceControl() {
  const state = useStore((s) => s.state);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  if (!state) return null;
  const v = state.voice;
  const err = (e: Error) => useStore.getState().setToast(e.message, 'error');
  return (
    <div className="voice-control" ref={ref}>
      <button
        className="btn small"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen(!open)}
        title="Join a voice channel"
      >
        {v.channelName ? `◉ ${v.channelName}` : 'Join voice'} ▾
      </button>
      {open ? (
        <div className="popover" role="menu">
          {v.channels.length === 0 ? (
            <p className="empty">Discord isn’t connected, so there are no channels yet.</p>
          ) : null}
          {v.channels.map((c) => (
            <button
              key={c.id}
              role="menuitem"
              className="btn small"
              style={{ width: '100%', textAlign: 'left', marginBottom: 4 }}
              aria-current={c.id === v.channelId ? 'true' : undefined}
              onClick={() => {
                setOpen(false);
                void api.post('/api/voice/join', { channelId: c.id }).catch(err);
              }}
            >
              {c.name}
              <span className="micro" style={{ display: 'block' }}>
                {c.members
                  .filter((m) => !m.bot)
                  .map((m) => m.name)
                  .join(', ') || 'empty'}
              </span>
            </button>
          ))}
          {v.channelId ? (
            <button
              role="menuitem"
              className="btn small danger"
              style={{ width: '100%' }}
              onClick={() => {
                setOpen(false);
                void api.post('/api/voice/leave').catch(err);
              }}
            >
              Leave voice
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
