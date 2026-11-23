import { useState } from 'react';
import type { PipelineView } from '../../../../shared/ipc';
import { useFileText } from '../../hooks/useFileText';
import { t } from '../../i18n/pt-BR';
import { joinRefs } from '../../lib/plan';
import { parseSpec } from '../../lib/specText';
import { canFollowToTasks, specsFor, type SpecRow } from '../../lib/stagePanels';
import { ConfirmDialog } from '../ConfirmDialog';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * Gate 3 for someone who is not technical: the specs as features, each to be confirmed ("Está certo") or sent back ("Algo está
 * errado", with what is wrong, which the agent takes into account). The first one that is not confirmed is open; the person can
 * open another, or take back a confirmation ("Rever"). Once every feature is confirmed, the person's go-ahead plans the deliveries.
 */
export function SimpleFeatures({
  view,
  sessionId,
  by,
  onChanged,
  onResume,
  onStarted,
  onTechnical,
}: {
  view: PipelineView;
  sessionId: string;
  /** Who is confirming (recorded with the review). */
  by: string;
  onChanged: () => Promise<void> | void;
  onResume: () => Promise<void>;
  onStarted: () => void;
  onTechnical: () => void;
}) {
  const data = specsFor(view);
  const rows = data?.rows ?? [];
  const firstPending = rows.find((r) => r.status !== 'reviewed')?.slug;
  const [opened, setOpened] = useState<string>();
  const [wrong, setWrong] = useState<string>();
  const [comment, setComment] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const current = opened ?? firstPending;
  const row = rows.find((r) => r.slug === current);
  const text = useFileText(sessionId, row?.path, row?.status);
  const details = text.state === 'ready' ? parseSpec(text.text) : undefined;
  const number = new Map(rows.map((r, i) => [r.slug, i + 1]));

  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    setError(undefined);
    try {
      await action();
    } catch (err) {
      setError(t.simple.features.failed(errorText(err)));
    } finally {
      setWorking(false);
    }
  };

  const confirm = (r: SpecRow) =>
    run(async () => {
      await window.alia.request('pipeline.reviewSpec', { sessionId, spec: r.slug, status: 'reviewed', by });
      setOpened(undefined);
      await onChanged();
    });

  const reopen = (r: SpecRow) =>
    run(async () => {
      await window.alia.request('pipeline.reviewSpec', { sessionId, spec: r.slug, status: 'in_review', by });
      setOpened(r.slug);
      await onChanged();
    });

  const sendBack = (r: SpecRow) =>
    run(async () => {
      setConfirming(false);
      await window.alia.request('pipeline.requestChanges', { sessionId, spec: r.slug, comment, by });
      setComment('');
      setWrong(undefined);
      setOpened(undefined);
      onStarted();
      await onChanged();
    });

  const plan = () =>
    run(async () => {
      await window.alia.request('pipeline.approveGate', { sessionId, gate: 'G3' });
      await onChanged();
      await onResume();
    });

  const architecture = view.state?.stages.find((s) => s.stage === 2);
  const technical = (view.state?.decisions ?? []).filter((d) => d.stage === 2);
  const architectureLabel = view.flow?.stages.find((s) => s.stage === 2)?.simple.title ?? '';

  return (
    <section className="simple-features" aria-labelledby="features-title" aria-busy={working} data-testid="simple-features">
      {architecture?.status === 'done' && (
        <div className="notice ok solution-done" role="status" data-testid="simple-solution-done">
          <p>
            <strong>{t.simple.features.solutionDone(architectureLabel)}</strong>{' '}
            {technical.length > 0 ? `${t.simple.features.decisions(technical.length)} ${technical[0].answer.replace(/[.\s]+$/, '')}.` : t.simple.features.noDecisions}
          </p>
          <button type="button" className="link-btn" onClick={onTechnical}>
            {t.simple.features.technicalDetails}
          </button>
        </div>
      )}

      <h2 id="features-title" className="simple-heading">
        {t.simple.features.title}
      </h2>
      {rows.length === 0 ? (
        <>
          <p className="lead">{t.simple.features.none}</p>
          <p className="hint">{t.simple.features.noneHint}</p>
        </>
      ) : (
        <>
          <p className="lead">{t.simple.features.intro(rows.length)}</p>
          <div className="progress-line">
            <strong>{t.simple.features.count(data!.reviewed, rows.length)}</strong>
            <span className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={rows.length} aria-valuenow={data!.reviewed} aria-label={t.simple.features.count(data!.reviewed, rows.length)}>
              <span style={{ width: `${(data!.reviewed / rows.length) * 100}%` }} />
            </span>
          </div>

          <ul className="feature-list" aria-label={t.simple.features.list}>
            {rows.map((r) => {
              const n = number.get(r.slug)!;
              const done = r.status === 'reviewed';
              const open = r.slug === current;
              const deps = r.dependsOn.map((d) => number.get(d)).filter((x): x is number => !!x).sort((a, z) => a - z);
              const sub = [r.persona ? t.simple.features.forWho(r.persona) : '', deps.length > 0 ? (deps.length === 1 ? t.simple.features.after(t.simple.features.feature(deps[0])) : t.simple.features.afterMany(t.simple.features.features(joinRefs(deps.map(String))))) : ''].filter(Boolean).join(' · ');
              return (
                <li key={r.slug} className={`card feature ${done ? 'confirmed' : ''} ${open ? 'open' : ''}`} data-feature={r.slug} data-status={r.status}>
                  <div className="feature-head">
                    <span className={`step-dot ${done ? 'done' : open ? 'current' : ''}`} aria-hidden="true">
                      {done ? '✓' : n}
                    </span>
                    <span className="grow">
                      <strong className="feature-title">{open ? r.title : `${n}. ${r.title}`}</strong>
                      {sub && <span className="hint">{sub}</span>}
                    </span>
                    {done ? (
                      <>
                        <span className="chip ok">{r.by && r.by !== by ? t.simple.features.confirmedBy(r.by) : t.simple.features.confirmed}</span>
                        <button type="button" className="link-btn" disabled={working} aria-label={`${t.simple.features.review}: ${r.title}`} onClick={() => void reopen(r)}>
                          {t.simple.features.review}
                        </button>
                      </>
                    ) : open ? (
                      <span className="chip waiting">{t.simple.features.waiting}</span>
                    ) : (
                      <button type="button" className="btn" disabled={working} aria-label={`${t.simple.features.check}: ${r.title}`} onClick={() => setOpened(r.slug)}>
                        {t.simple.features.check}
                      </button>
                    )}
                  </div>

                  {open && !done && (
                    <div className="feature-body">
                      {text.state === 'loading' && <p className="hint">{t.simple.features.loading}</p>}
                      {details?.summary && <p className="feature-summary">{details.summary}</p>}
                      {details && details.criteria.length > 0 && (
                        <>
                          <h3>{t.simple.features.readyWhen}</h3>
                          <ul className="criteria">
                            {details.criteria.map((c) => (
                              <li key={c}>
                                <span className="box" aria-hidden="true" /> {c}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                      {details?.later && (
                        <>
                          <h3>{t.simple.features.later}</h3>
                          <p>{details.later}</p>
                        </>
                      )}
                      {text.state !== 'loading' && !details?.summary && !details?.criteria.length && !details?.later && <p className="hint">{t.simple.features.noDetails}</p>}

                      {wrong === r.slug ? (
                        <div className="wrong-form" data-testid="simple-wrong">
                          <label className="field">
                            <span>{t.simple.features.wrongTitle}</span>
                            <span className="hint">{t.simple.features.wrongHint}</span>
                            <textarea rows={3} value={comment} placeholder={t.simple.features.wrongPlaceholder} data-testid="simple-wrong-text" onChange={(e) => setComment(e.target.value)} />
                          </label>
                          <div className="feature-actions">
                            <button type="button" className="btn" disabled={working} onClick={() => (setWrong(undefined), setComment(''))}>
                              {t.simple.features.wrongCancel}
                            </button>
                            <button type="button" className="btn primary" disabled={working || !comment.trim()} onClick={() => setConfirming(true)}>
                              {t.simple.features.wrongSend}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="feature-actions">
                          <button type="button" className="btn" disabled={working} data-testid="simple-wrong-open" onClick={() => setWrong(r.slug)}>
                            {t.simple.features.wrong}
                          </button>
                          <button type="button" className="btn primary" disabled={working} data-testid="simple-right" onClick={() => void confirm(r)}>
                            {working ? t.simple.features.saving : t.simple.features.right}
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          {data && canFollowToTasks(data) && (
            <div className="notice ok all-right" role="status" data-testid="simple-all-right">
              <p>
                <strong>{t.simple.features.allRight}.</strong> {t.simple.features.allRightText}
              </p>
              <button type="button" className="btn primary" disabled={working} data-testid="simple-plan" onClick={() => void plan()}>
                {working ? t.simple.features.going : t.simple.features.go}
              </button>
            </div>
          )}
        </>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {confirming && row && <ConfirmDialog title={t.simple.features.wrongConfirmTitle} body={t.simple.features.wrongConfirmBody} confirmLabel={t.simple.features.wrongConfirm} cancelLabel={t.simple.features.wrongKeep} onConfirm={() => void sendBack(row)} onCancel={() => setConfirming(false)} />}
    </section>
  );
}
