import { useId } from 'react';
import type { PipelineFlow } from '../../../../shared/ipc';
import { useIntakeFiles } from '../../hooks/useIntakeFiles';
import { t } from '../../i18n/pt-BR';
import { applyTranscript, canStart, removeRow, rowProblem, rowState, startBlockedReason, type IntakeRow } from '../../lib/intake';
import type { Mode } from '../../lib/simple';
import type { IntakeNotice } from '../PipelineIntake';
import { SimpleHeader } from './SimpleHeader';

const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** What the person has typed so far; the app keeps it, so it survives a start that was refused. */
export interface NewProjectForm {
  name: string;
  request: string;
  owner: string;
}

/**
 * "Novo projeto": the client (the flow), the project's name, what the person wants built, the files they already have, and who
 * answers the technical questions. Below, what happens next in the flow and where the person takes part. Nothing starts until
 * "Começar", and the engine refuses (writing nothing) if a file cannot be used.
 */
export function SimpleNewProject({
  flows,
  flowId,
  onFlow,
  form,
  setForm,
  rows,
  setRows,
  owners,
  notice,
  setNotice,
  starting,
  onStart,
  onCancel,
  mode,
  onMode,
}: {
  flows: PipelineFlow[];
  flowId: string;
  onFlow: (flow: string) => void;
  form: NewProjectForm;
  setForm: (form: NewProjectForm) => void;
  rows: IntakeRow[];
  setRows: (update: (rows: IntakeRow[]) => IntakeRow[]) => void;
  /** Names the person has given before, to pick from. */
  owners: string[];
  notice: IntakeNotice;
  setNotice: (notice: IntakeNotice) => void;
  starting: boolean;
  onStart: () => void;
  onCancel: () => void;
  mode: Mode;
  onMode: (mode: Mode) => void;
}) {
  const ids = { flow: useId(), name: useId(), request: useId(), owner: useId(), owners: useId() };
  const flow = flows.find((f) => f.id === flowId) ?? flows[0];
  const { pick, attachTranscript, dropping } = useIntakeFiles({
    needsProject: false,
    flow: flow?.id ?? '',
    rows,
    setRows,
    onChange: () => setNotice({ problems: [] }),
    onError: (e) => setNotice({ problems: [], error: e }),
  });

  const hasName = form.name.trim() !== '';
  const hasAsk = form.request.trim() !== '' || rows.length > 0;
  const filesOk = rows.length === 0 || canStart(rows);
  const blocked = !hasName ? t.simple.newScreen.needName : !hasAsk ? t.simple.newScreen.needSomething : !filesOk ? fileReason(rows) : undefined;

  return (
    <section className={`simple-screen simple-new ${dropping ? 'dropping' : ''}`} aria-labelledby="simple-title" data-testid="simple-new-project">
      <SimpleHeader title={t.simple.newScreen.title} mode={mode} onMode={onMode} />
      <div className="simple-body">
        <p className="lead">{t.simple.newScreen.intro}</p>

        <div className="card">
          <div className="field">
            <label htmlFor={ids.flow}>{t.simple.newScreen.client}</label>
            <select id={ids.flow} value={flow?.id ?? ''} disabled={flows.length < 2} data-testid="simple-client" onChange={(e) => onFlow(e.target.value)}>
              {flows.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={ids.name}>{t.simple.newScreen.name}</label>
            <input id={ids.name} value={form.name} maxLength={100} placeholder={t.simple.newScreen.namePlaceholder} data-testid="simple-name" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor={ids.request}>{t.simple.newScreen.request}</label>
            <span className="hint" id={`${ids.request}-hint`}>
              {t.simple.newScreen.requestHint}
            </span>
            <textarea id={ids.request} rows={4} value={form.request} aria-describedby={`${ids.request}-hint`} placeholder={t.simple.newScreen.requestPlaceholder} data-testid="simple-request" onChange={(e) => setForm({ ...form, request: e.target.value })} />
          </div>
        </div>

        <div className="card">
          <h2>{t.simple.newScreen.filesTitle}</h2>
          <p className="hint">{t.simple.newScreen.filesHint}</p>
          <div className="dropzone" data-testid="simple-dropzone">
            <p className="drop-title">{t.simple.newScreen.drop}</p>
            <button type="button" className="btn" onClick={() => void pick()}>
              {t.simple.newScreen.choose}
            </button>
          </div>
          {rows.length > 0 && (
            <ul className="inputs simple-files" aria-label={t.simple.newScreen.list}>
              {rows.map((row) => {
                const state = rowState(row);
                const problem = rowProblem(row);
                const item = row.item;
                const name = item?.name ?? fileName(row.path);
                return (
                  <li key={row.path} className={`input ${state}`} data-state={state} data-name={name}>
                    <div className="input-head">
                      <span className="input-name" title={row.path}>
                        {name}
                      </span>
                      {item && <span className="chip">{t.simple.newScreen.kind[item.class] ?? item.class}</span>}
                      {state === 'ok' && <span className="ok-text">✓ {t.simple.newScreen.ready}</span>}
                      {state === 'loading' && <span className="hint">{t.simple.newScreen.checking}</span>}
                      <button type="button" className="icon-btn" aria-label={t.simple.newScreen.remove(name)} title={t.simple.newScreen.remove(name)} onClick={() => setRows((cur) => removeRow(cur, row.path))}>
                        ×
                      </button>
                    </div>
                    {problem && (
                      <p className="error problem" role="alert">
                        <strong>{t.simple.newScreen.cantUse}:</strong> {problem}
                      </p>
                    )}
                    {item?.class === 'recording' && (
                      <div className="transcript">
                        {row.transcript ? (
                          <p className="hint">
                            {t.simple.newScreen.transcriptOf(row.transcript.item?.name ?? fileName(row.transcript.path))}{' '}
                            <button type="button" className="icon-btn" aria-label={t.simple.newScreen.removeTranscript(row.transcript.item?.name ?? fileName(row.transcript.path))} onClick={() => setRows((cur) => applyTranscript(cur, row.path, undefined))}>
                              ×
                            </button>
                          </p>
                        ) : (
                          <>
                            <p className="hint">{t.simple.newScreen.recording}</p>
                            <button type="button" className="btn small" onClick={() => void attachTranscript(row)}>
                              {t.simple.newScreen.attachTranscript}
                            </button>
                          </>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="card">
          <h2>
            <label htmlFor={ids.owner}>{t.simple.newScreen.ownerTitle}</label>
          </h2>
          <p className="hint" id={`${ids.owner}-hint`}>
            {t.simple.newScreen.ownerHint}
          </p>
          <input id={ids.owner} list={ids.owners} value={form.owner} maxLength={100} placeholder={t.simple.newScreen.ownerPlaceholder} aria-describedby={`${ids.owner}-hint`} data-testid="simple-owner" onChange={(e) => setForm({ ...form, owner: e.target.value })} />
          <datalist id={ids.owners}>
            {owners.map((o) => (
              <option key={o} value={o} />
            ))}
          </datalist>
        </div>

        {flow && (
          <div className="card">
            <h2>{t.simple.newScreen.flowTitle(flow.name)}</h2>
            <ol className="flow-steps" data-testid="simple-flow-steps">
              {flow.stages.map((s) => (
                <li key={s.stage}>
                  <span className="step-n" aria-hidden="true">
                    {s.stage}
                  </span>
                  <span className="grow">
                    <strong>{s.simple.title}</strong>
                    <span className="hint">{s.simple.description}</span>
                  </span>
                  {s.simple.participates && <span className="chip small info">{t.simple.newScreen.participates}</span>}
                </li>
              ))}
            </ol>
          </div>
        )}

        {notice.problems.length > 0 && (
          <div className="banner error-banner" role="alert" data-testid="simple-refused">
            <p>{t.simple.newScreen.refused}</p>
            <ul>
              {notice.problems.map((p, i) => (
                <li key={`${p.path}:${i}`}>{p.message}</li>
              ))}
            </ul>
          </div>
        )}
        {notice.error && (
          <p className="banner error-banner" role="alert">
            {t.simple.newScreen.failed(notice.error)}
          </p>
        )}

        <div className="simple-actions">
          {blocked && (
            <span id="simple-start-why" className="hint">
              {blocked}
            </span>
          )}
          <span className="grow" />
          <button type="button" className="btn" onClick={onCancel}>
            {t.simple.newScreen.cancel}
          </button>
          <button type="button" className="btn primary" disabled={!!blocked || starting} aria-describedby={blocked ? 'simple-start-why' : undefined} data-testid="simple-start" onClick={onStart}>
            {starting ? t.simple.newScreen.starting : t.simple.newScreen.start}
          </button>
        </div>
      </div>
    </section>
  );
}

/** Why the files hold the start back, in the simple view's words. */
function fileReason(rows: IntakeRow[]): string {
  const why = startBlockedReason(rows);
  if (rows.some((r) => rowState(r) === 'loading')) return t.simple.newScreen.checkingFiles;
  if (rows.some((r) => rowState(r) === 'problem')) return t.simple.newScreen.fixFiles;
  if (rows.some((r) => rowState(r) === 'needs_transcript')) return t.simple.newScreen.attachFirst;
  return why ?? '';
}
