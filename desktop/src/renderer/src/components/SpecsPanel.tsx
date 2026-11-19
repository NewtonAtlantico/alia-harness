import { useState } from 'react';
import { useFileText } from '../hooks/useFileText';
import { t } from '../i18n/pt-BR';
import { canFollowToTasks, reviewLine, type SpecRow, type SpecsData } from '../lib/stagePanels';
import { ConfirmDialog } from './ConfirmDialog';
import { Markdown } from './Markdown';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * Gate 3: the table of specs (persona, what each depends on, who reviewed it and when), a preview of the spec being reviewed
 * (the file itself, rendered), the review comment, and the three decisions that are the user's: approve the spec, ask for
 * changes (which sends the comment to the agent and reopens the specs stage), and, once every spec is reviewed, follow to the tasks.
 */
export function SpecsPanel({
  data,
  sessionId,
  by,
  onChanged,
  onResume,
  onStarted,
}: {
  data: SpecsData;
  sessionId: string;
  /** Who is reviewing (recorded with the review). */
  by: string;
  onChanged: () => Promise<void> | void;
  onResume: () => Promise<void>;
  /** A run was started by asking for changes. */
  onStarted: () => void;
}) {
  const [selected, setSelected] = useState<string>();
  const [comment, setComment] = useState('');
  const [working, setWorking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const row: SpecRow | undefined = data.rows.find((r) => r.slug === selected);
  const text = useFileText(sessionId, row?.path, row?.status);
  const index = useFileText(sessionId, data.rows.length === 0 ? data.index : undefined);
  const left = data.rows.length - data.reviewed;

  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await action();
    } catch (err) {
      setError(t.run.specs.failed(errorText(err)));
    } finally {
      setWorking(false);
    }
  };

  const approve = () =>
    run(async () => {
      if (!row) return;
      await window.alia.request('pipeline.reviewSpec', { sessionId, spec: row.slug, status: 'reviewed', ...(comment.trim() ? { comment } : {}), by });
      setMessage(t.run.specs.approved(row.title));
      setComment('');
      setSelected(undefined);
      await onChanged();
    });

  const requestChanges = () =>
    run(async () => {
      if (!row) return;
      setConfirming(false);
      await window.alia.request('pipeline.requestChanges', { sessionId, spec: row.slug, comment, by });
      setComment('');
      setSelected(undefined);
      onStarted();
      await onChanged();
    });

  const follow = () =>
    run(async () => {
      await window.alia.request('pipeline.approveGate', { sessionId, gate: 'G3' });
      await onChanged();
      await onResume();
    });

  return (
    <section className="stage-panel specs" aria-labelledby="specs-title" data-testid="specs-panel" aria-busy={working}>
      <h2 id="specs-title">
        {t.run.specs.title} <span className="hint">{data.rows.length > 0 ? t.run.specs.count(data.reviewed, data.rows.length) : ''}</span>
      </h2>

      {data.resolvedGaps.length > 0 && (
        <div className="notice ok" role="status" data-testid="resolved-gap">
          <strong>{t.run.specs.resolvedGap}:</strong> {data.resolvedGaps.map((g) => g.prompt).join(' · ')}
        </div>
      )}

      {data.rows.length === 0 ? (
        <>
          <p className="hint">{t.run.specs.none}</p>
          {index.state === 'ready' && (
            <>
              <p className="hint">{t.run.specs.noStructured}</p>
              <div className="doc-preview">
                <Markdown text={index.text} />
              </div>
            </>
          )}
        </>
      ) : (
        <table className="spec-table">
          <thead>
            <tr>
              <th scope="col">{t.run.specs.columns.spec}</th>
              <th scope="col">{t.run.specs.columns.persona}</th>
              <th scope="col">{t.run.specs.columns.dependsOn}</th>
              <th scope="col">{t.run.specs.columns.status}</th>
              <th scope="col">
                <span className="sr-only">{t.run.specs.review}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.slug} data-spec={r.slug} data-status={r.status} className={selected === r.slug ? 'selected' : ''}>
                <th scope="row">
                  {r.title}
                  <span className="hint"> {r.slug}</span>
                </th>
                <td>{r.persona ?? '—'}</td>
                <td>{r.dependsOn.length > 0 ? r.dependsOn.join(', ') : t.run.specs.noDeps}</td>
                <td>
                  <span className={`chip small spec-${r.status}`}>{reviewLine(r)}</span>
                </td>
                <td>
                  <button type="button" className="btn small" aria-expanded={selected === r.slug} aria-label={t.run.specs.reviewOf(r.title)} onClick={() => setSelected(selected === r.slug ? undefined : r.slug)}>
                    {t.run.specs.review}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {row && (
        <div className="spec-review" role="group" aria-label={t.run.specs.preview(row.title)} data-testid="spec-review">
          <h3>{t.run.specs.preview(row.title)}</h3>
          {text.state === 'loading' && <p className="hint">{t.run.specs.loading}</p>}
          {(text.state === 'missing' || text.state === 'none') && <p className="hint">{t.run.specs.noFile}</p>}
          {text.state === 'ready' && (
            <div className="doc-preview" tabIndex={0} data-testid="spec-preview">
              <Markdown text={text.text} />
            </div>
          )}
          <label className="field">
            <span>{t.run.specs.comment}</span>
            <textarea rows={3} value={comment} placeholder={t.run.specs.commentPlaceholder} onChange={(e) => setComment(e.target.value)} />
          </label>
          <div className="actions">
            <button type="button" className="btn primary" disabled={working || row.status === 'reviewed'} onClick={() => void approve()}>
              {t.run.specs.approve}
            </button>
            <button type="button" className="btn" disabled={working || !comment.trim()} title={comment.trim() ? undefined : t.run.specs.requestNeedsComment} onClick={() => setConfirming(true)}>
              {t.run.specs.requestChanges}
            </button>
          </div>
          {!comment.trim() && <p className="hint">{t.run.specs.requestNeedsComment}</p>}
        </div>
      )}

      {data.rows.length > 0 && (
        <div className="actions follow">
          <button type="button" className="btn primary" disabled={working || !canFollowToTasks(data)} aria-describedby="follow-why" onClick={() => void follow()} data-testid="follow-tasks">
            {working ? t.run.specs.working : t.run.specs.follow}
          </button>
          {!canFollowToTasks(data) && (
            <span id="follow-why" className="hint">
              {left > 0 ? t.run.specs.followHint(left) : t.run.specs.followGaps}
            </span>
          )}
        </div>
      )}

      {message && (
        <p className="hint" role="status" data-testid="specs-message">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirming && row && <ConfirmDialog title={t.run.specs.confirmTitle} body={t.run.specs.confirmBody} confirmLabel={t.run.specs.confirm} cancelLabel={t.run.specs.cancel} onConfirm={() => void requestChanges()} onCancel={() => setConfirming(false)} />}
    </section>
  );
}
