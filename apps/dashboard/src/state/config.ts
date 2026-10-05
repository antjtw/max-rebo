import { useCallback, useEffect, useState } from 'react';
import type { ConfigName } from '@cantina/shared';
import type { ApiError } from './api.ts';
import { api } from './api.ts';
import { useStore } from './store.ts';

/** Load a config file as structured data and save it back (comments are preserved server-side). */
export function useConfig<T>(name: ConfigName): {
  value: T | null;
  save: (v: T) => Promise<boolean>;
  errors: string[];
  reload: () => void;
} {
  const [value, setValue] = useState<T | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const reload = useCallback(() => {
    void api.get<{ value: T }>(`/api/config/${name}`).then((r) => setValue(r.value));
  }, [name]);
  useEffect(reload, [reload]);
  const save = async (v: T) => {
    const previous = value;
    setValue(v); // optimistic: controls respond immediately
    try {
      const r = await api.put<{ value: T }>(`/api/config/${name}`, { value: v });
      setValue(r.value);
      setErrors([]);
      useStore.getState().setToast(`Saved ${name}`);
      return true;
    } catch (e) {
      const err = e as ApiError;
      setValue(previous);
      setErrors([err.message, ...err.details]);
      return false;
    }
  };
  return { value, save, errors, reload };
}
