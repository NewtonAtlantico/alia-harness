import { useId, useState, type ReactNode } from 'react';
import type { JiraState } from '../hooks/useJira';
import { t } from '../i18n/pt-BR';
import { ConfirmDialog } from './ConfirmDialog';
import { Dialog } from './Dialog';
import { JiraConnectDialog } from './JiraConnectDialog';

type Open = 'connect' | 'manage' | 'change' | 'confirm' | 'disconnect';

function LinkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M6.5 9.5l3-3M7 4.5l1-1a3 3 0 014.2 4.2l-1 1M9 11.5l-1 1a3 3 0 01-4.2-4.2l1-1" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/**
 * The Jira side of "Publicar issues", for both views. Without a connection it puts "Conectar ao Jira" beside what the screen already
 * has (`children`: its own publish button). With one it shows who is connected, "Gerenciar", and the primary "Publicar no Jira", which
 * asks first ("Criar no Jira" with what will be created) and then hands over to `onPublish`.
 */
export function JiraPublish({
  projectPath,
  jira,
  tasks,
  points,
  working,
  disabled,
  onPublish,
  onError,
  publishLabel,
  primary = true,
  children,
}: {
  projectPath: string;
  jira: JiraState;
  tasks: number;
  points: number;
  /** Something is already being sent or checked: nothing here can start. */
  working: boolean;
  /** The backlog is blocked: it cannot be sent. */
  disabled: boolean;
  onPublish: () => void;
  onError: (message: string) => void;
  /** The primary button's words (the simple view says "Enviar ao Jira"). */
  publishLabel?: string;
  primary?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState<Open>();
  const manageId = useId();
  const confirmId = useId();
  const key = jira.target?.projectKey ?? '';
  const close = () => setOpen(undefined);

  const connected = async () => {
    await jira.reload();
    close();
  };

  const disconnect = async () => {
    close();
    const why = await jira.disconnect();
    if (why) onError(t.jira.failed(why));
  };

  return (
    <>
      {jira.ready ? (
        <>
          <span className="pill ok jira-pill" data-testid="jira-pill">
            {t.jira.connected(key)}
          </span>
          <button type="button" className="btn" disabled={working} onClick={() => setOpen('manage')} data-testid="jira-manage">
            {t.jira.manage}
          </button>
          <button type="button" className={`btn ${primary ? 'primary' : ''}`} disabled={working || disabled} onClick={() => setOpen('confirm')} data-testid="jira-publish">
            {working ? t.jira.publishing : (publishLabel ?? t.jira.publish)}
          </button>
        </>
      ) : (
        <>
          <button type="button" className="btn jira-connect" disabled={working} onClick={() => setOpen('connect')} data-testid="jira-connect">
            <LinkIcon /> {t.jira.connect}
          </button>
          {children}
        </>
      )}

      {open === 'connect' && <JiraConnectDialog projectPath={projectPath} onClose={close} onConnected={() => void connected()} />}
      {open === 'change' && jira.server && <JiraConnectDialog projectPath={projectPath} existing={{ server: jira.server, target: jira.target }} onClose={close} onConnected={() => void connected()} />}

      {open === 'manage' && jira.server && (
        <Dialog labelledBy={manageId} onCancel={close}>
          <h2 id={manageId}>{t.jira.manageDialog.title}</h2>
          <p data-testid="jira-manage-status">{t.jira.manageDialog.status(key, jira.server.label)}</p>
          <div className="dialog-actions">
            <button type="button" className="btn danger" onClick={() => setOpen('disconnect')} data-testid="jira-disconnect">
              {t.jira.manageDialog.disconnect}
            </button>
            <span className="grow" />
            <button type="button" className="btn" onClick={close}>
              {t.jira.manageDialog.close}
            </button>
            <button type="button" className="btn primary" onClick={() => setOpen('change')} data-autofocus data-testid="jira-change">
              {t.jira.manageDialog.changeProject}
            </button>
          </div>
        </Dialog>
      )}

      {open === 'disconnect' && <ConfirmDialog title={t.jira.disconnectDialog.title} body={t.jira.disconnectDialog.body} confirmLabel={t.jira.disconnectDialog.confirm} cancelLabel={t.jira.disconnectDialog.cancel} onConfirm={() => void disconnect()} onCancel={close} />}

      {open === 'confirm' && (
        <Dialog labelledBy={confirmId} onCancel={close}>
          <h2 id={confirmId}>{t.jira.confirm.title}</h2>
          <p data-testid="jira-confirm-body">{t.jira.confirm.body(tasks, points, key)}</p>
          <p className="hint">{t.jira.confirm.detail}</p>
          <div className="dialog-actions">
            <button type="button" className="btn" data-autofocus onClick={close}>
              {t.jira.confirm.cancel}
            </button>
            <button
              type="button"
              className="btn primary"
              data-testid="jira-confirm"
              onClick={() => {
                close();
                onPublish();
              }}
            >
              {t.jira.confirm.confirm}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
