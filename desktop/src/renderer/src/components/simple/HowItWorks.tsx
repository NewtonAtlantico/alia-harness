import { useId } from 'react';
import type { PipelineFlow } from '../../../../shared/ipc';
import { t } from '../../i18n/pt-BR';
import { Dialog } from '../Dialog';

/** "Como funciona": what the app does with what the person gives it, step by step, and where they take part. */
export function HowItWorks({ flow, onClose }: { flow?: PipelineFlow; onClose: () => void }) {
  const titleId = useId();
  return (
    <Dialog labelledBy={titleId} onCancel={onClose}>
      <h2 id={titleId}>{t.simple.howDialog.title}</h2>
      <p>{t.simple.howDialog.intro}</p>
      {flow && (
        <ol className="how-steps">
          {flow.stages.map((s) => (
            <li key={s.stage}>
              <strong>{s.simple.title}</strong>
              <span className="hint">{s.simple.description}</span>
            </li>
          ))}
        </ol>
      )}
      <p className="hint">{t.simple.howDialog.saved}</p>
      <div className="dialog-actions">
        <button type="button" className="btn primary" data-autofocus onClick={onClose}>
          {t.simple.howDialog.close}
        </button>
      </div>
    </Dialog>
  );
}
