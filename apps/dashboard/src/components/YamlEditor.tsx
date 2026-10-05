import { useEffect, useState } from 'react';
import type { ConfigName } from '@cantina/shared';
import type { ApiError } from '../state/api.ts';
import { api } from '../state/api.ts';
import { useStore } from '../state/store.ts';

/** Raw YAML editing with server-side validation; errors come back with line numbers (SPEC §14). */
export function YamlEditor({
  name,
  rows = 18,
  onSaved,
}: {
  name: ConfigName;
  rows?: number;
  onSaved?: () => void;
}) {
  const [text, setText] = useState('');
  const [loaded, setLoaded] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const load = () =>
    void api.get<{ text: string }>(`/api/config/${name}`).then((r) => {
      setText(r.text);
      setLoaded(r.text);
      setErrors([]);
    });
  useEffect(load, [name]);
  const save = async () => {
    try {
      await api.put(`/api/config/${name}`, { text });
      setLoaded(text);
      setErrors([]);
      useStore.getState().setToast(`Saved ${name}`);
      onSaved?.();
    } catch (e) {
      const err = e as ApiError;
      setErrors([err.message, ...err.details]);
    }
  };
  return (
    <div>
      <textarea
        className="input"
        style={{ width: '100%' }}
        rows={rows}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label={`${name} YAML`}
      />
      {errors.length ? (
        <div className="errors" role="alert">
          {errors.join('\n')}
        </div>
      ) : null}
      <div className="row" style={{ marginTop: 6 }}>
        <button
          className="btn primary small"
          onClick={() => void save()}
          disabled={text === loaded}
        >
          Save
        </button>
        <button className="btn small" onClick={load} disabled={text === loaded}>
          Revert
        </button>
        <span className="micro">
          Invalid changes are refused; the previous config keeps running.
        </span>
      </div>
    </div>
  );
}
