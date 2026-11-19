import { useEffect, useState } from 'react';
import type { PingResult } from '../../shared/ipc';
import logoAlia from './assets/logo-alia.png';

/** Placeholder screen for the scaffold (A1): proves the page can reach the engine. The real screens start at A3. */
export function App() {
  const [ping, setPing] = useState<PingResult | { error: string } | undefined>();

  useEffect(() => {
    window.alia.ping().then(setPing, (err) => setPing({ error: String(err?.message ?? err) }));
  }, []);

  return (
    <main style={{ padding: 'var(--space-6)' }}>
      <img src={logoAlia} alt="alia" height={48} />
      <h1 style={{ fontFamily: 'var(--font-display)', color: 'var(--brand-navy)', fontWeight: 700 }}>Harness</h1>
      <p>
        {!ping && 'Conectando ao motor…'}
        {ping && 'error' in ping && `Motor indisponível: ${ping.error}`}
        {ping && 'pong' in ping && `Motor ativo (processo ${ping.pid}, Node ${ping.node}, ${ping.coreStages} etapas no core).`}
      </p>
    </main>
  );
}
