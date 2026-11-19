import { useEffect, useState } from 'react';
import type { PingResult, SettingsView } from '../../shared/ipc';
import { SettingsScreen } from './components/SettingsScreen';
import { TitleBar } from './components/TitleBar';
import { t } from './i18n/pt-BR';

type Screen = 'home' | 'settings';

/** The app's screens come one task at a time (A5 onwards); for now: a home placeholder and the settings screen. */
export function App() {
  const [screen, setScreen] = useState<Screen>('home');
  const [settings, setSettings] = useState<SettingsView>();
  const [ping, setPing] = useState<PingResult | { error: string } | undefined>();

  useEffect(() => {
    window.alia.request('settings.get', {}).then((s) => {
      setSettings(s);
      if (!s.configured) setScreen('settings'); // first run: nothing works until the endpoint and key are set
    });
    window.alia.ping().then(setPing, (err) => setPing({ error: String(err?.message ?? err) }));
    return window.alia.onMessage((m) => {
      if (m.kind === 'command' && m.command === 'open_settings') setScreen('settings');
    });
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <main className="content">
        {screen === 'settings' ? (
          <SettingsScreen onClose={() => setScreen('home')} onSaved={setSettings} />
        ) : (
          <>
            <h1 className="display">{settings?.displayName ? `${settings.displayName}, ${t.appName}` : t.appName}</h1>
            <p>
              {!ping && t.engine.connecting}
              {ping && 'error' in ping && t.engine.unavailable(ping.error)}
              {ping && 'pong' in ping && t.engine.active(ping.pid, ping.node, ping.coreStages)}
            </p>
            {settings && !settings.configured && (
              <p className="banner info">
                {t.home.needsSetup} <button type="button" className="btn primary" onClick={() => setScreen('settings')}>{t.home.configure}</button>
              </p>
            )}
            <button type="button" className="btn" onClick={() => setScreen('settings')}>{t.home.openSettings}</button>
          </>
        )}
      </main>
    </div>
  );
}
