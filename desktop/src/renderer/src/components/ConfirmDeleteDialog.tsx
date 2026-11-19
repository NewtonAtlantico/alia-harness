import { t } from '../i18n/pt-BR';
import { Dialog } from './Dialog';

/** The cancel button has the focus first: deleting is never one keystroke away. */
export function ConfirmDeleteDialog({ title, onConfirm, onCancel }: { title: string; onConfirm: () => void; onCancel: () => void }) {
  return (
    <Dialog labelledBy="delete-title" onCancel={onCancel}>
      <h2 id="delete-title">{t.confirmDelete.title}</h2>
      <p>{t.confirmDelete.body(title)}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" data-autofocus onClick={onCancel}>
          {t.confirmDelete.cancel}
        </button>
        <button type="button" className="btn danger" onClick={onConfirm}>
          {t.confirmDelete.confirm}
        </button>
      </div>
    </Dialog>
  );
}
