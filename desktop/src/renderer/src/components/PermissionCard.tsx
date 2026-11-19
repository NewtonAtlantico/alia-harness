import { useId } from 'react';
import type { PermissionDecision } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import type { PermissionInteraction } from '../lib/interactions';

/**
 * The approval card: what the agent wants to run, why it matters, and the three answers. It never takes the focus (a
 * stray Enter while the user types must not approve a command) and announces itself to screen readers instead.
 * A dangerous command cannot be "always allowed": the button is not offered, and the card says why.
 */
export function PermissionCard({ interaction, queued, onDecide }: { interaction: PermissionInteraction; queued: number; onDecide: (decision: PermissionDecision) => void }) {
  const titleId = useId();
  const { command, reasons, dangerous, canAlwaysAllow, requester } = interaction;
  return (
    <section className={`interaction-card permission ${dangerous ? 'danger' : ''}`} role="group" aria-labelledby={titleId} data-testid="interaction-card" data-kind="permission" data-dangerous={dangerous}>
      <span className="sr-only" role="alert">
        {t.approval.announce(command)}
      </span>
      <h2 id={titleId}>{dangerous ? t.approval.dangerousTitle : t.approval.title}</h2>
      {requester && <p className="hint">{t.approval.requestedBy(requester)}</p>}
      <pre className="cmd" aria-label={t.approval.command}>
        {command}
      </pre>
      {reasons.length > 0 && (
        <>
          <p className="hint reasons-title">{t.approval.reasons}</p>
          <ul className="reasons">
            {reasons.map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </>
      )}
      <div className="actions">
        <button type="button" className="btn primary" onClick={() => onDecide('allow_once')}>
          {t.approval.allowOnce}
        </button>
        {canAlwaysAllow && (
          <button type="button" className="btn" onClick={() => onDecide('allow_always')}>
            {t.approval.allowAlways}
          </button>
        )}
        <button type="button" className="btn danger" onClick={() => onDecide('deny')}>
          {t.approval.deny}
        </button>
      </div>
      {!canAlwaysAllow && <p className="hint">{t.approval.noAlways}</p>}
      {queued > 0 && <p className="hint">{t.approval.queued(queued)}</p>}
    </section>
  );
}
