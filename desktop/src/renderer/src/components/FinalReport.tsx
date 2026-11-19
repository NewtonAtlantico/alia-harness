import { useState } from 'react';
import type { IssuePublishingStatus, PipelineView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { blockerText, canPublish, checkRow, totalsLine } from '../lib/finalReport';
import { ConfirmDialog } from './ConfirmDialog';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const MARK: Record<string, string> = { pass: '✓', fail: '✗', unknown: '?' };

/**
 * The done screen: the backlog by spec (ids, points, dependencies), the checks across specs with each failure explained, the
 * final report (specs, tasks, points, ADRs), "Nada bloqueado" or what blocks, the assumptions with their owners, the way to
 * docs/tasks/, and "Publicar issues". Publishing asks core at every attempt; without a tracker connection it shows the warning
 * and writes drafts only after the user confirms.
 */
export function FinalReport({ view, sessionId, onOpen, onStarted }: { view: PipelineView; sessionId: string; onOpen: (path: string) => void; onStarted: () => void }) {
  const [asking, setAsking] = useState<IssuePublishingStatus>();
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const report = view.report;
  const state = view.state;
  if (!report || !state) return null;
  const rows = report.checks.map(checkRow);
  const blocked = report.blockers.length > 0;

  const publish = async (confirmDrafts: boolean) => {
    setWorking(true);
    setError(undefined);
    try {
      const r = await window.alia.request('issues.publish', { sessionId, ...(confirmDrafts ? { confirmDrafts: true } : {}) });
      setAsking(undefined);
      if (!r.started) return setAsking(r.status);
      onStarted();
    } catch (err) {
      setAsking(undefined);
      setError(t.run.report.failed(errorText(err)));
    } finally {
      setWorking(false);
    }
  };

  return (
    <section className="stage-panel final-report" aria-labelledby="report-title" data-testid="final-report">
      <h2 id="report-title">
        {t.run.report.title} <span className="hint" data-testid="report-totals">{totalsLine(report)}</span>
      </h2>

      {blocked ? (
        <div className="notice blocked" data-testid="report-blocked">
          <strong>{t.run.report.blockedTitle}</strong>
          <ul>
            {report.blockers.map((b, i) => (
              <li key={`${b.kind}:${b.ref}:${i}`}>{blockerText(b)}</li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="notice ok" role="status" data-testid="report-clear">
          <strong>{t.run.report.allClear}</strong> <span>{t.run.report.allClearHint}</span>
        </div>
      )}

      <h3>{t.run.report.backlog}</h3>
      {report.backlog.length === 0 && <p className="hint">{t.run.report.noBacklog}</p>}
      {report.backlog.map((spec) => (
        <details key={spec.slug} className="backlog-spec" data-backlog={spec.slug}>
          <summary>
            <strong>{spec.title}</strong> <span className="hint">{t.run.report.taskCount(spec.taskCount, spec.points)}</span>
            {spec.dependsOn.length > 0 && <span className="hint"> · {t.run.report.dependsOnSpecs(spec.dependsOn.join(', '))}</span>}
          </summary>
          <table className="spec-table">
            <thead>
              <tr>
                <th scope="col">{t.run.report.columns.id}</th>
                <th scope="col">{t.run.report.columns.task}</th>
                <th scope="col">{t.run.report.columns.points}</th>
                <th scope="col">{t.run.report.columns.dependsOn}</th>
              </tr>
            </thead>
            <tbody>
              {spec.tasks.map((task, i) => (
                <tr key={`${task.id ?? task.title}:${i}`} data-task={task.id ?? task.title}>
                  <td>{task.id ?? '—'}</td>
                  <th scope="row">{task.title}</th>
                  <td>{task.points ?? '?'}</td>
                  <td>{task.dependsOn.length > 0 ? task.dependsOn.join(', ') : t.run.report.noDeps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      ))}

      <h3>{t.run.report.checksTitle}</h3>
      <ul className="checks" data-testid="checks">
        {rows.map((c) => (
          <li key={c.key} className={`check ${c.state}`} data-check={c.key} data-state={c.state}>
            <span className="mark" aria-hidden="true">
              {MARK[c.state]}
            </span>
            <div>
              <strong>{c.label}</strong> <span className="chip small">{t.run.report.checks.state[c.state]}</span>
              <p className="hint">{c.explanation}</p>
              {c.items.length > 0 && (
                <ul className="items">
                  {c.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              )}
            </div>
          </li>
        ))}
      </ul>

      <h3>{t.run.report.assumptions}</h3>
      {state.assumptions.length === 0 && <p className="hint">{t.run.report.noAssumptions}</p>}
      <ul className="assumptions">
        {state.assumptions.map((a, n) => (
          <li key={`${a.text}:${n}`} data-assumption>
            {a.text} <span className="hint">· {t.run.panel.ownerOf(a.owner)}</span>
          </li>
        ))}
      </ul>

      {state.adrs.length > 0 && (
        <>
          <h3>{t.run.report.adrs}</h3>
          <ul className="adrs">
            {state.adrs.map((a) => (
              <li key={a.id} data-adr={a.id}>
                <strong>{a.id}</strong> {a.title} <span className="chip small">{a.status}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="actions follow">
        <button type="button" className="btn" onClick={() => onOpen('docs/tasks')} disabled={!view.artifacts.some((a) => a.stage === 4 && a.exists)}>
          {t.run.report.openTasks}
        </button>
        <button type="button" className="btn primary" disabled={working || !canPublish(report)} aria-describedby="publish-why" onClick={() => void publish(false)} data-testid="publish-issues">
          {working ? t.run.report.publishing : t.run.report.publish}
        </button>
        <span id="publish-why" className="hint">
          {canPublish(report) ? t.run.report.publishHint : t.run.report.publishBlocked}
        </span>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          title={t.run.report.draftsTitle}
          body={`${t.run.report.draftsLead} ${t.run.report.draftsWhy} ${asking.warning ?? ''}`.trim()}
          confirmLabel={t.run.report.draftsConfirm}
          cancelLabel={t.run.report.draftsCancel}
          onConfirm={() => void publish(true)}
          onCancel={() => setAsking(undefined)}
        />
      )}
    </section>
  );
}

