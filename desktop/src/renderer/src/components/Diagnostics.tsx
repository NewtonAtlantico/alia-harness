import { useCallback, useEffect, useState } from 'react';
import type { DiagnosticsResult } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

type Item = DiagnosticsResult['items'][number];

/** The word for a result: an optional thing that is missing is a warning, not an error. */
const tone = (i: Item): 'ok' | 'warn' | 'bad' => (i.status === 'ok' ? 'ok' : i.status === 'warn' || i.optional ? 'warn' : 'bad');

/**
 * What the app needs from this machine and whether it is there, each missing piece with how to get it. It is read when the
 * screen opens and again on request; "Copiar relatório" puts the same facts (no secrets, nothing of the conversations) on the
 * clipboard for a message to support.
 */
export function Diagnostics() {
  const [result, setResult] = useState<DiagnosticsResult>();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();

  const run = useCallback(async () => {
    setWorking(true);
    setError(undefined);
    try {
      setResult(await window.alia.request('diagnostics.run', {}));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setWorking(false);
    }
  }, []);

  useEffect(() => {
    void run();
  }, [run]);

  const copy = async () => {
    setMessage(undefined);
    try {
      await window.alia.request('diagnostics.copy', {});
      setMessage(t.settings.diagnostics.copied);
    } catch (err) {
      setError(errorText(err));
    }
  };

  return (
    <div className="card" data-testid="diagnostics" aria-busy={working}>
      <h2>{t.settings.diagnostics.title}</h2>
      <p className="hint">{t.settings.diagnostics.hint}</p>
      {!result && !error && <p className="hint">{t.settings.diagnostics.checking}</p>}
      {result && (
        <ul className="rules diag">
          {result.items.map((i) => {
            const k = tone(i);
            const text = t.settings.diagnostics.items[i.id];
            return (
              <li key={i.id} data-diag={i.id} data-status={i.status} data-tone={k}>
                <span className="grow">
                  <strong>{text.label}</strong>
                  {i.optional && <span className="hint"> · {t.settings.diagnostics.optional}</span>}
                  <span className="hint block">{i.status === 'ok' ? text.ok(i.value ?? '') : i.status === 'warn' ? text.warn(i.value ?? '') : text.missing(i.value ?? '')}</span>
                  {i.status !== 'ok' && <span className="hint block fix">{text.fix}</span>}
                </span>
                <span className={`pill ${k}`}>{t.settings.diagnostics.state[k]}</span>
              </li>
            );
          })}
        </ul>
      )}
      {result && (
        <p className="hint" data-testid="diag-app">
          {result.app.name} {result.app.version} · Electron {result.app.electron} · {result.app.platform} {result.app.arch}
        </p>
      )}
      <div className="actions">
        <button type="button" className="btn" disabled={working} onClick={() => void run()}>
          {working ? t.settings.diagnostics.checking : t.settings.diagnostics.again}
        </button>
        <button type="button" className="btn" disabled={!result} onClick={() => void copy()}>
          {t.settings.diagnostics.copy}
        </button>
        {message && (
          <span className="ok-text" role="status">
            {message}
          </span>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
