import { useId } from 'react';
import { Dialog } from './Dialog';

/** A confirmation the page draws itself. The cancel button has the focus first: a destructive action is never one keystroke away. */
export function ConfirmDialog({ title, body, confirmLabel, cancelLabel, onConfirm, onCancel }: { title: string; body: string; confirmLabel: string; cancelLabel: string; onConfirm: () => void; onCancel: () => void }) {
  const titleId = useId();
  return (
    <Dialog labelledBy={titleId} onCancel={onCancel}>
      <h2 id={titleId}>{title}</h2>
      <p>{body}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" data-autofocus onClick={onCancel}>
          {cancelLabel}
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}
