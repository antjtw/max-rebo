import { create } from 'zustand';
import { useStore } from './store.ts';

/**
 * Visual preferences (SPEC §12.6). CRT effects come from settings.yaml (`ui`), so they follow Ant
 * across screens; reduced motion follows the OS unless overridden on this device.
 */
interface Prefs {
  crt: boolean;
  scanlines: boolean;
  flicker: boolean;
  bloom: boolean;
  reducedMotion: boolean;
  forceReducedMotion: boolean | null;
  setForceReducedMotion: (v: boolean | null) => void;
}

const media =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : null;

function readForced(): boolean | null {
  try {
    const v = localStorage.getItem('cantina.reducedMotion');
    return v === null ? null : v === 'true';
  } catch {
    return null;
  }
}

export const usePrefs = create<Prefs>((set) => {
  const forced = readForced();
  return {
    crt: true,
    scanlines: true,
    flicker: true,
    bloom: true,
    forceReducedMotion: forced,
    reducedMotion: forced ?? media?.matches ?? false,
    setForceReducedMotion: (v) => {
      try {
        if (v === null) localStorage.removeItem('cantina.reducedMotion');
        else localStorage.setItem('cantina.reducedMotion', String(v));
      } catch {
        // per-device convenience only
      }
      set({ forceReducedMotion: v, reducedMotion: v ?? media?.matches ?? false });
    },
  };
});

media?.addEventListener?.('change', (e) => {
  if (usePrefs.getState().forceReducedMotion === null)
    usePrefs.setState({ reducedMotion: e.matches });
});

useStore.subscribe((s) => {
  const ui = s.state?.ui;
  if (!ui) return;
  const p = usePrefs.getState();
  if (
    p.crt !== ui.crt ||
    p.scanlines !== ui.scanlines ||
    p.flicker !== ui.flicker ||
    p.bloom !== ui.bloom
  ) {
    usePrefs.setState({
      crt: ui.crt,
      scanlines: ui.scanlines,
      flicker: ui.flicker,
      bloom: ui.bloom,
    });
  }
});
