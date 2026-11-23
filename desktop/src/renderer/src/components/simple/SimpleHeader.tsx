import type { Mode, SimpleStep } from '../../lib/simple';
import { t } from '../../i18n/pt-BR';
import { ModeToggle } from './ModeToggle';

const MARK: Record<SimpleStep['state'], string> = { done: '✓', current: '', next: '' };

/** The top of a screen of the simple view: what the project is called, who it is for, the mode switch, and its four steps. */
export function SimpleHeader({ title, client, mode, onMode, steps }: { title: string; client?: string; mode: Mode; onMode: (mode: Mode) => void; steps?: SimpleStep[] }) {
  return (
    <header className="simple-header">
      <div className="simple-titlebar">
        <h1 id="simple-title">{title}</h1>
        {client && <span className="chip project">{t.simple.client(client)}</span>}
        <span className="grow" />
        <ModeToggle mode={mode} onChange={onMode} />
      </div>
      {steps && (
        <ol className="simple-steps" aria-label={t.simple.steps.label}>
          {steps.map((s) => (
            <li key={s.stage} className={s.state} data-step={s.stage} data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
              <span className="step-dot" aria-hidden="true">
                {MARK[s.state] || s.stage}
              </span>
              <span className="step-text">
                <strong>{s.title}</strong>
                <span className="hint">{s.detail}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </header>
  );
}
