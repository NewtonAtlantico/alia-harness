import { useCallback, useEffect, useState } from 'react';
import type { ChangeInfo, DiffResult, RevertResult } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { ConfirmDialog } from './ConfirmDialog';
import { DiffView } from './DiffView';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

type Skipped = RevertResult['skipped'][number];

function skippedText(s: Skipped): string {
  if (s.reason === 'modified') return t.panel.changes.skipped.modified;
  if (s.reason === 'untracked') return t.panel.changes.skipped.untracked;
  if (s.reason === 'unknown') return t.panel.changes.skipped.unknown;
  return t.panel.changes.skipped.failed(s.detail ?? '');
}

/**
 * What the agent changed in this conversation and has not been kept or undone: each file with its +/- counts, the diff on
 * demand, and "Desfazer" / "Manter" for one file or all. A file that was edited after the agent is never overwritten: it is
 * reported and stays pending. Changes made through shell commands are not tracked, and the tab says so.
 */
export function ChangesTab({ sessionId, refreshKey }: { sessionId: string; refreshKey: string }) {
  const [changes, setChanges] = useState<ChangeInfo[]>([]);
  const [open, setOpen] = useState<Record<string, DiffResult | 'loading'>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [summary, setSummary] = useState<string>();
  const [error, setError] = useState<string>();
  const [confirm, setConfirm] = useState<string[] | 'all'>();
  const api = window.alia.request;

  const load = useCallback(async () => {
    try {
      const list = await api('changes.list', { sessionId });
      setChanges(list);
      // A file that is no longer pending loses its open diff; one that changed again gets a fresh one.
      setOpen((cur) => Object.fromEntries(Object.entries(cur).filter(([p]) => list.some((c) => c.path === p))));
    } catch (err) {
      setError(errorText(err));
    }
  }, [api, sessionId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // A file that changed again since its diff was fetched: fetch it again.
  useEffect(() => {
    setOpen((cur) => (Object.keys(cur).length > 0 ? {} : cur));
  }, [refreshKey]);

  const toggle = async (c: ChangeInfo) => {
    if (open[c.path]) return setOpen(({ [c.path]: _gone, ...rest }) => rest);
    setOpen((cur) => ({ ...cur, [c.path]: 'loading' }));
    try {
      const diff = await api('changes.diff', { sessionId, path: c.path });
      setOpen((cur) => ({ ...cur, [c.path]: diff }));
    } catch (err) {
      setOpen(({ [c.path]: _gone, ...rest }) => rest);
      setError(errorText(err));
    }
  };

  const keep = async (paths?: string[]) => {
    setError(undefined);
    try {
      const { kept } = await api('changes.keep', { sessionId, ...(paths ? { paths } : {}) });
      setNotes({});
      setSummary(t.panel.changes.kept(kept));
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const revert = async (paths?: string[]) => {
    setError(undefined);
    try {
      const result = await api('changes.revert', { sessionId, ...(paths ? { paths } : {}) });
      setNotes(Object.fromEntries(result.skipped.map((s) => [s.path, skippedText(s)])));
      setSummary(result.reverted.length > 0 ? t.panel.changes.undone(result.reverted.length) : undefined);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  };

  const added = changes.reduce((n, c) => n + c.added, 0);
  const removed = changes.reduce((n, c) => n + c.removed, 0);
  const confirmCount = confirm === 'all' ? changes.length : (confirm?.length ?? 0);

  return (
    <div className="changes-tab">
      {changes.length > 0 && (
        <div className="changes-head">
          <strong>{t.panel.changes.summary(changes.length)}</strong>
          <span className="tool-stats">
            <span className="add">+{added}</span> <span className="rem">−{removed}</span>
          </span>
          <span className="grow" />
          <button type="button" className="btn small danger" onClick={() => setConfirm('all')}>
            {t.panel.changes.undoAll}
          </button>
          <button type="button" className="btn small" onClick={() => void keep()}>
            {t.panel.changes.keepAll}
          </button>
        </div>
      )}

      {summary && <p className="ok-text" role="status" data-testid="changes-summary">{summary}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      {changes.length === 0 ? (
        <div className="empty">
          <p>{t.panel.changes.none}</p>
          <p className="hint">{t.panel.changes.noneHint}</p>
        </div>
      ) : (
        <ul className="change-list" aria-label={t.panel.changes.summary(changes.length)}>
          {changes.map((c) => {
            const diff = open[c.path];
            const tracked = c.kind !== 'untracked';
            return (
              <li key={c.path} className={`change ${c.kind}`} data-path={c.path}>
                <div className="change-row">
                  <button type="button" className="change-main" aria-expanded={tracked ? !!diff : undefined} disabled={!tracked} onClick={() => void toggle(c)} title={t.panel.changes.showDiff(c.path)}>
                    <span className="tool-icon" aria-hidden="true">{tracked ? (diff ? '▾' : '▸') : '·'}</span>
                    <code className="path">{c.path}</code>
                    <span className={`badge ${c.kind === 'created' ? 'ok' : c.kind === 'untracked' ? 'muted' : ''}`}>{t.panel.changes.kind[c.kind]}</span>
                    {tracked && (
                      <span className="tool-stats">
                        <span className="add">+{c.added}</span> <span className="rem">−{c.removed}</span>
                      </span>
                    )}
                  </button>
                  <span className="change-actions">
                    <button type="button" className="btn small danger" aria-label={t.panel.changes.undoFile(c.path)} onClick={() => setConfirm([c.path])} disabled={!tracked}>
                      {t.panel.changes.undo}
                    </button>
                    <button type="button" className="btn small" aria-label={t.panel.changes.keepFile(c.path)} onClick={() => void keep([c.path])}>
                      {t.panel.changes.keep}
                    </button>
                  </span>
                </div>
                {!tracked && <p className="hint indent">{t.panel.changes.untracked}</p>}
                {notes[c.path] && <p className="error indent" role="alert" data-testid="conflict">{notes[c.path]}</p>}
                {diff === 'loading' && <p className="hint indent">{t.panel.changes.loadingDiff}</p>}
                {diff && diff !== 'loading' && (diff.diff === null ? <p className="hint indent">{t.panel.changes.noDiff}</p> : <DiffView diff={diff.diff} truncated={diff.truncated} label={c.path} />)}
              </li>
            );
          })}
        </ul>
      )}

      <p className="hint not-tracked" data-testid="not-tracked">{t.panel.changes.notTracked}</p>

      {confirm && (
        <ConfirmDialog
          title={t.panel.changes.confirmTitle(confirmCount)}
          body={t.panel.changes.confirmBody}
          confirmLabel={t.panel.changes.confirm}
          cancelLabel={t.panel.changes.cancel}
          onCancel={() => setConfirm(undefined)}
          onConfirm={() => {
            const target = confirm === 'all' ? undefined : confirm;
            setConfirm(undefined);
            void revert(target);
          }}
        />
      )}
    </div>
  );
}
