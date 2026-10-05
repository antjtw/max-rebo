import { useEffect, useState } from 'react';
import { Header } from './components/Header.tsx';
import { ConsoleRoute } from './routes/Console.tsx';
import { LibraryRoute } from './routes/Library.tsx';
import { PlayersRoute } from './routes/Players.tsx';
import { ScenesRoute } from './routes/Scenes.tsx';
import { SettingsRoute } from './routes/Settings.tsx';
import { SimulatorRoute } from './routes/Simulator.tsx';
import { TriggersRoute } from './routes/Triggers.tsx';
import { usePrefs } from './state/prefs.ts';
import { useShortcuts } from './state/shortcuts.ts';
import { connect, useStore } from './state/store.ts';

function useRoute(): string {
  const read = () => location.hash.replace(/^#\/?/, '').split('?')[0] || 'console';
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => setRoute(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function App() {
  const route = useRoute();
  const prefs = usePrefs();
  const state = useStore((s) => s.state);
  const toast = useStore((s) => s.toast);
  const connected = useStore((s) => s.connected);
  useEffect(() => connect(), []);
  useShortcuts(route === 'console');
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => useStore.setState({ toast: null }), 4000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    const cls = document.body.classList;
    cls.toggle('crt', prefs.crt);
    cls.toggle('scanlines', prefs.crt && prefs.scanlines);
    cls.toggle('flicker', prefs.crt && prefs.flicker && !prefs.reducedMotion);
    cls.toggle('reduced-motion', prefs.reducedMotion);
  }, [prefs]);

  return (
    <div className="app">
      <div>
        {state?.lan.enabled ? (
          <div className="banner warn">
            LAN access on · other devices on your network can open this console with the PIN
          </div>
        ) : null}
        {!connected ? <div className="banner">Connection to core lost · reconnecting</div> : null}
        <Header route={route} />
      </div>
      {route === 'library' ? (
        <LibraryRoute />
      ) : route === 'triggers' ? (
        <TriggersRoute />
      ) : route === 'players' ? (
        <PlayersRoute />
      ) : route === 'scenes' ? (
        <ScenesRoute />
      ) : route === 'settings' ? (
        <SettingsRoute />
      ) : route === 'simulator' ? (
        <SimulatorRoute />
      ) : (
        <ConsoleRoute />
      )}
      {toast ? (
        <div className={`toast${toast.kind === 'error' ? ' error' : ''}`} role="status">
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
