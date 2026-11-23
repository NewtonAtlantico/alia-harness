import { t } from '../../i18n/pt-BR';
import type { SimpleScreen } from '../../lib/simple';

/**
 * The screens of the simple view where there is nothing to answer: the work is running, it stopped, the technical owner has to
 * decide, the person only has to go on, or something needs attention in the technical view.
 */
export function SimpleStatus({
  screen,
  step,
  owner,
  names,
  busy,
  error,
  onPause,
  onResume,
  onGo,
  onTechnical,
}: {
  screen: Extract<SimpleScreen, { kind: 'working' | 'stopped' | 'owner' | 'approve' | 'attention' | 'empty' }>;
  /** The step the project is at, in the simple view's words. */
  step: string;
  /** Who answers the technical questions, when the person said. */
  owner: string;
  /** The files that changed (for `attention`). */
  names: string[];
  busy: boolean;
  error?: string;
  onPause: () => void;
  onResume: () => void;
  onGo: () => void;
  onTechnical: () => void;
}) {
  const body = (() => {
    switch (screen.kind) {
      case 'working':
        return (
          <>
            <span className="spinner big" role="img" aria-label={t.simple.working.title(step)} />
            <h2 className="simple-heading">{t.simple.working.title(step)}</h2>
            <p className="lead">{t.simple.working.text}</p>
            <button type="button" className="btn" data-testid="simple-pause" onClick={onPause}>
              {t.simple.working.pause}
            </button>
          </>
        );
      case 'stopped':
      case 'empty':
        return (
          <>
            <h2 className="simple-heading">{t.simple.working.stopped}</h2>
            <p className="lead">{t.simple.working.stoppedText}</p>
            {screen.kind === 'stopped' && (
              <button type="button" className="btn primary" disabled={busy} data-testid="simple-resume" onClick={onResume}>
                {busy ? t.simple.working.starting : t.simple.working.resume}
              </button>
            )}
          </>
        );
      case 'owner':
        return (
          <>
            <h2 className="simple-heading">{t.simple.owner.title}</h2>
            <p className="lead">{owner ? t.simple.owner.textWith(owner) : t.simple.owner.textWithout}</p>
            {screen.open > 0 && <p className="hint">{t.simple.owner.points(screen.open)}</p>}
            <button type="button" className="btn" data-testid="simple-open-technical" onClick={onTechnical}>
              {t.simple.owner.open}
            </button>
            <p className="hint">{t.simple.owner.openHint}</p>
          </>
        );
      case 'approve':
        return (
          <>
            <h2 className="simple-heading">{t.simple.approve.title}</h2>
            <p className="lead">{t.simple.approve.text}</p>
            <button type="button" className="btn primary" disabled={busy} data-testid="simple-go" onClick={onGo}>
              {busy ? t.simple.approve.going : t.simple.approve.go}
            </button>
          </>
        );
      case 'attention':
        return (
          <>
            <h2 className="simple-heading">{screen.reason === 'damaged' ? t.simple.attention.damaged : t.simple.attention.inputsChanged}</h2>
            <p className="lead">{screen.reason === 'damaged' ? t.simple.attention.damagedText : t.simple.attention.inputsChangedText(names.join(', '))}</p>
            <button type="button" className="btn" onClick={onTechnical}>
              {t.simple.owner.open}
            </button>
          </>
        );
    }
  })();
  return (
    <section className="simple-status" data-testid="simple-status" data-screen={screen.kind} aria-live="polite">
      {body}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
