import { useEffect, useState } from 'react';
import type { PingResult } from '../../shared/ipc';
import { TitleBar } from './components/TitleBar';
import { t } from './i18n/pt-BR';

/** Placeholder content while the screens are built (A5 onwards): proves the page can reach the engine. */
export function App() {
  const [ping, setPing] = useState<PingResult | { error: string } | undefined>();

  useEffect(() => {
    window.alia.ping().then(setPing, (err) => setPing({ error: String(err?.message ?? err) }));
  }, []);

  return (
    <div className="app">
      <TitleBar />
      <main className="content">
        <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--brand-navy)', fontWeight: 700, marginTop: 0 }}>{t.appName}</h1>
        <p>
          {!ping && t.engine.connecting}
          {ping && 'error' in ping && t.engine.unavailable(ping.error)}
          {ping && 'pong' in ping && t.engine.active(ping.pid, ping.node, ping.coreStages)}
        </p>
      </main>
    </div>
  );
}
