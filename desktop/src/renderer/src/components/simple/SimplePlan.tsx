import { useState } from 'react';
import type { IssuePublishingStatus, PipelineView, ProjectMeta } from '../../../../shared/ipc';
import { t } from '../../i18n/pt-BR';
import { canPublish } from '../../lib/finalReport';
import { planFor, planHtml, planMarkdown } from '../../lib/plan';
import { ConfirmDialog } from '../ConfirmDialog';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * The end of the flow for someone who is not technical: what the plan comes to (features, tasks, points), the order the features
 * are delivered in and why, what was decided, and what is still open with whom. From here the plan goes to the technical team
 * (published as issues, or written as drafts when there is no connection to their system) or is taken away as a PDF or a link.
 */
export function SimplePlan({
  view,
  sessionId,
  project,
  title,
  handedOff,
  running,
  onStarted,
  onTechnical,
}: {
  view: PipelineView;
  sessionId: string;
  project: string;
  title: string;
  handedOff?: ProjectMeta['handedOff'];
  running: boolean;
  onStarted: () => void;
  onTechnical: () => void;
}) {
  const [asking, setAsking] = useState<IssuePublishingStatus>();
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const plan = planFor(view);
  if (!plan || !view.report) return null;
  const ready = canPublish(view.report);

  const publish = async (confirmDrafts: boolean) => {
    setWorking(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const r = await window.alia.request('issues.publish', { sessionId, ...(confirmDrafts ? { confirmDrafts: true } : {}) });
      setAsking(undefined);
      if (!r.started) return setAsking(r.status);
      onStarted();
    } catch (err) {
      setAsking(undefined);
      setError(t.simple.plan.failed(errorText(err)));
    } finally {
      setWorking(false);
    }
  };

  const exportSummary = async (kind: 'pdf' | 'link') => {
    setWorking(true);
    setError(undefined);
    setMessage(undefined);
    try {
      const r = await window.alia.request('summary.export', { projectPath: project, kind, title: t.simple.summary.title(title), html: planHtml(plan, title, view.flow?.name), markdown: planMarkdown(plan, title, view.flow?.name) });
      if (kind === 'link' && r.saved) setMessage(t.simple.plan.linkCopied);
      else if (r.saved && r.path) setMessage(t.simple.plan.pdfSaved(r.path));
    } catch (err) {
      setError(t.simple.plan.failed(errorText(err)));
    } finally {
      setWorking(false);
    }
  };

  const sent = !!handedOff && !running;

  return (
    <section className="simple-plan" aria-labelledby="plan-title" aria-busy={working} data-testid="simple-plan-screen">
      <h2 id="plan-title" className="simple-heading">
        {t.simple.plan.title}
      </h2>
      <p className="lead">{t.simple.plan.intro}</p>

      {!ready && (
        <div className="notice blocked" role="status" data-testid="simple-plan-blocked">
          <strong>{t.simple.plan.blocked}</strong>
          <button type="button" className="link-btn" onClick={onTechnical}>
            {t.simple.plan.technicalPlan}
          </button>
        </div>
      )}

      <div className={`card send-card ${sent ? 'sent' : ''}`} data-testid="simple-send">
        <div className="grow">
          <h3>{sent ? t.simple.plan.sentTitle : t.simple.plan.sendTitle}</h3>
          <p className="hint">{sent ? t.simple.plan.sentText : t.simple.plan.sendText}</p>
        </div>
        <button type="button" className={`btn ${sent ? '' : 'primary'}`} disabled={working || running || !ready} data-testid="simple-send-button" onClick={() => void publish(false)}>
          {running ? t.simple.plan.sending : sent ? t.simple.plan.sentAgain : t.simple.plan.send}
        </button>
      </div>

      <div className="card">
        <dl className="stats" data-testid="simple-stats">
          <div>
            <dd>{plan.features}</dd>
            <dt>{t.simple.plan.features}</dt>
          </div>
          <div>
            <dd>{plan.tasks}</dd>
            <dt>{t.simple.plan.tasks}</dt>
          </div>
          <div>
            <dd>{plan.points}</dd>
            <dt>{t.simple.plan.points}</dt>
          </div>
        </dl>
        <details className="why">
          <summary>{t.simple.plan.whatPoints}</summary>
          <p>{t.simple.plan.pointsExplain}</p>
        </details>
      </div>

      <div className="card">
        <h3>{t.simple.plan.order}</h3>
        <ol className="order" data-testid="simple-order">
          {plan.order.map((f) => (
            <li key={f.slug} data-feature={f.slug}>
              <span className="step-n" aria-hidden="true">
                {f.n}
              </span>
              <span className="grow">
                <strong>{f.title}</strong>
                <span className="hint">{f.note}</span>
              </span>
              <span className="bar" aria-hidden="true">
                <span style={{ width: `${Math.max(8, f.share * 100)}%` }} />
              </span>
              <span className="hint nowrap">{t.simple.plan.pointsAndTasks(f.points, f.tasks)}</span>
            </li>
          ))}
        </ol>
      </div>

      <div className="card">
        <h3>{t.simple.plan.decisions}</h3>
        {plan.decisions.length === 0 ? (
          <p className="hint">{t.simple.plan.noDecisions}</p>
        ) : (
          <ul className="tick-list" data-testid="simple-decisions">
            {plan.decisions.map((d) => (
              <li key={d}>
                <span className="mark" aria-hidden="true">
                  ✓
                </span>{' '}
                {d}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card">
        <div className="row">
          <h3 className="grow">{t.simple.plan.pending}</h3>
          {plan.pending.length > 0 && <span className="chip waiting">{t.simple.plan.pendingCount(plan.pending.length)}</span>}
        </div>
        {plan.pending.length === 0 ? (
          <p className="hint">{t.simple.plan.noPending}</p>
        ) : (
          <ul className="pending" data-testid="simple-pending">
            {plan.pending.map((p, i) => (
              <li key={`${p.text}:${i}`}>
                <span>{p.text}</span>
                <span className="hint">{t.simple.plan.pendingOwner(p.who, p.step)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="simple-actions plan-actions">
        <button type="button" className="btn" disabled={working} data-testid="simple-pdf" onClick={() => void exportSummary('pdf')}>
          {t.simple.plan.downloadPdf}
        </button>
        <button type="button" className="btn" disabled={working} data-testid="simple-link" onClick={() => void exportSummary('link')}>
          {t.simple.plan.copyLink}
        </button>
        <span className="grow" />
        <button type="button" className="link-btn" onClick={onTechnical}>
          {t.simple.plan.technicalPlan}
        </button>
      </div>
      {message && (
        <p className="hint" role="status" data-testid="simple-plan-message">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {asking && <ConfirmDialog title={t.simple.plan.draftsTitle} body={t.simple.plan.draftsText} confirmLabel={t.simple.plan.draftsConfirm} cancelLabel={t.simple.plan.draftsCancel} onConfirm={() => void publish(true)} onCancel={() => setAsking(undefined)} />}
    </section>
  );
}
