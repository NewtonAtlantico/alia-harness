import type { PipelineView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { canResume, runChip, stepperFor } from '../lib/pipelineRun';

const MARK: Record<string, string> = { done: '✓', active: '●', waiting: '!', stale: '↻', blocked: '!', pending: '' };

/**
 * The top of a pipeline's conversation: the stepper (Entradas and the four stages, each with its status and gate progress),
 * the status chip, "Pausar" while it works and "Retomar" when it stopped, and the way to STATE.md.
 */
export function PipelineHeader({
  view,
  running,
  busy,
  error,
  onPause,
  onResume,
  onOpenState,
}: {
  view: PipelineView;
  running: boolean;
  busy: boolean;
  error?: string;
  onPause: () => void;
  onResume: () => void;
  onOpenState: () => void;
}) {
  const steps = stepperFor(view, running);
  const chip = runChip(view, running);
  return (
    <section className="pipeline-header" aria-label={t.run.header} data-testid="pipeline-header">
      <ol className="stepper" aria-label={t.run.stepperLabel}>
        {steps.map((s) => (
          <li key={s.id} className={`step ${s.state}`} data-step={s.id} data-state={s.state} aria-current={s.state === 'active' || s.state === 'waiting' ? 'step' : undefined}>
            <span className="step-mark" aria-hidden="true">
              {MARK[s.state]}
            </span>
            <span className="step-text">
              <span className="step-label">{s.label}</span>
              <span className="hint">
                {s.detail ?? ''}
                <span className="sr-only">
                  {s.detail ? ', ' : ''}
                  {t.run.stepState[s.state]}
                </span>
              </span>
            </span>
          </li>
        ))}
      </ol>
      <div className="pipeline-bar">
        {chip && (
          <span className={`chip ${chip.tone}`} role="status" data-testid="run-chip">
            {chip.label}
          </span>
        )}
        <span className="grow" />
        {running ? (
          <button type="button" className="btn small" onClick={onPause} title={t.run.pauseTitle} data-testid="pipeline-pause">
            {t.run.pause}
          </button>
        ) : (
          canResume(view, running) && (
            <button type="button" className="btn small primary" disabled={busy} onClick={onResume} title={t.run.resumeTitle} data-testid="pipeline-resume">
              {t.run.resume}
            </button>
          )
        )}
        <button type="button" className="btn small" disabled={!view.markdownExists} onClick={onOpenState} title={t.run.openStateTitle} data-testid="open-state">
          {t.run.openState}
        </button>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
