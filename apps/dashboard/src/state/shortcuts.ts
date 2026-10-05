import { useEffect } from 'react';
import { api } from './api.ts';
import { useStore } from './store.ts';

/** Keyboard shortcuts (SPEC §12.9). Ignored while typing in a field. */
export function useShortcuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === 'INPUT' ||
          t.tagName === 'TEXTAREA' ||
          t.tagName === 'SELECT' ||
          t.isContentEditable)
      ) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const st = useStore.getState().state;
      if (!st) return;
      const err = (x: Error) => useStore.getState().setToast(x.message, 'error');
      const k = e.key;
      if (/^[1-9]$/.test(k)) {
        const scene = st.scene.scenes[Number(k) - 1];
        if (scene) void api.post('/api/scene', { sceneId: scene.id }).catch(err);
      } else if (k === 'Enter' && st.scene.suggestion) {
        void api.post(`/api/suggestion/${st.scene.suggestion.suggestionId}/accept`);
      } else if (k === 'Escape' && st.scene.suggestion) {
        void api.post(`/api/suggestion/${st.scene.suggestion.suggestionId}/dismiss`);
      } else if (k === ' ') {
        void api.post('/api/music/pause', { paused: !st.mixer.paused });
      } else if (k === 'n' || k === 'N') {
        void api.post('/api/music/next');
      } else if (k === 'l' || k === 'L') {
        void api.post('/api/lock', { locked: !st.automation.locked });
      } else if (k === 'm' || k === 'M') {
        const modes = ['manual', 'suggest', 'auto'] as const;
        void api.post('/api/mode', { mode: modes[(modes.indexOf(st.automation.mode) + 1) % 3] });
      } else if (k === 'P' && e.shiftKey) {
        void api.post('/api/panic');
      } else if (k === '/') {
        document.getElementById('sb-search')?.focus();
      } else {
        const hot = st.soundboard.find(
          (b) => b.hotkey && b.hotkey.toLowerCase() === k.toLowerCase(),
        );
        if (hot) void api.post('/api/sfx/fire', { sfxId: hot.id }).catch(err);
        else return;
      }
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}
