import { useEffect, useState } from 'react';
import type { IntakeProblem, PipelineFlow, PipelineInputRef, PipelineStatus } from '../../../shared/ipc';
import { useIntakeFiles } from '../hooks/useIntakeFiles';
import { t } from '../i18n/pt-BR';
import { applyTranscript, canStart, describeStop, removeRow, rowProblem, rowState, startBlockedReason, toInputs, type IntakeRow } from '../lib/intake';
import { humanSize } from '../lib/localCommands';
import { projectName } from '../lib/projectName';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export interface IntakeNotice {
  problems: IntakeProblem[];
  error?: string;
}

export interface IntakeProps {
  projects: string[];
  project?: string;
  onProject: (project: string) => void;
  rows: IntakeRow[];
  setRows: (update: (rows: IntakeRow[]) => IntakeRow[]) => void;
  /** Why the last start was refused (nothing was written), or failed. Kept by the app: the screen is left and come back to while the engine is asked. */
  notice: IntakeNotice;
  setNotice: (notice: IntakeNotice) => void;
  /** The flows to choose from, the one chosen, and what happens when another is chosen. */
  flows: PipelineFlow[];
  flowId: string;
  onFlow: (flow: string) => void;
  /** Starts the pipeline with these files, in this flow. Resolves with the problems when it refused (nothing was written). */
  onStart: (project: string, inputs: PipelineInputRef[], flow: string) => Promise<IntakeProblem[] | undefined>;
  onResume: (project: string) => Promise<string | undefined>;
  /** Bumped by the app when a pipeline run starts or ends, so the banner is read again. */
  refreshKey?: unknown;
}

/**
 * "Novo pipeline": the flow the pipeline runs, the project it is for, a banner when it already has a state, and the
 * files to start with, each shown with what it is and which skill reads it. Nothing runs until "Iniciar pipeline", and the engine
 * refuses to start (writing nothing) if any file cannot be used.
 */
export function PipelineIntake({ projects, project, onProject, rows, setRows, notice, setNotice, flows, flowId, onFlow, onStart, onResume, refreshKey }: IntakeProps) {
  const [status, setStatus] = useState<PipelineStatus>();
  const [starting, setStarting] = useState(false);
  const { problems, error } = notice;
  const setProblems = (p: IntakeProblem[]) => setNotice({ problems: p });
  const setError = (e: string | undefined) => setNotice({ problems: [], error: e });
  const api = window.alia.request;

  useEffect(() => {
    if (!project) return setStatus(undefined);
    let current = true;
    api('pipeline.status', { projectPath: project })
      .then((s) => current && setStatus(s))
      .catch(() => current && setStatus(undefined));
    return () => {
      current = false;
    };
  }, [project, refreshKey]);

  // A pipeline that already exists keeps its flow; a new one runs the flow chosen here.
  const locked = !!status?.exists && status.next.kind !== 'damaged' && !!status.flow && flows.some((f) => f.id === status.flow);
  const activeFlow = locked ? status!.flow! : flowId;
  const flow = flows.find((f) => f.id === activeFlow) ?? flows[0];

  const { pick, attachTranscript, dropping } = useIntakeFiles({
    project,
    needsProject: true,
    flow: activeFlow,
    rows,
    setRows,
    onChange: () => setProblems([]),
    onError: setError,
  });

  const start = async () => {
    if (!project || !canStart(rows)) return;
    setStarting(true);
    setError(undefined);
    setProblems([]);
    try {
      const refused = await onStart(project, toInputs(rows), activeFlow);
      if (refused) setProblems(refused);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const resume = async () => {
    if (!project) return;
    setStarting(true);
    setError(undefined);
    try {
      const failed = await onResume(project);
      if (failed) setError(failed);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setStarting(false);
    }
  };

  const damaged = status?.exists && status.next.kind === 'damaged';
  const existing = status?.exists && !damaged;
  const blocked = project ? startBlockedReason(rows) : t.pipeline.needProject;

  return (
    <section className={`intake ${dropping ? 'dropping' : ''}`} aria-labelledby="intake-title" data-testid="pipeline-intake">
      <p className="eyebrow">{t.pipeline.eyebrow}</p>
      <h1 id="intake-title" className="display">
        {t.pipeline.title}
      </h1>
      <p className="lead">{t.pipeline.intro}</p>

      <div className="card flow-card" data-testid="flow-card">
        <div className="field row">
          <label htmlFor="intake-flow">{t.pipeline.flow}</label>
          <select id="intake-flow" value={flow?.id ?? ''} disabled={locked || flows.length === 0} aria-describedby="intake-flow-hint" data-testid="flow-select" onChange={(e) => onFlow(e.target.value)}>
            {flows.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <span id="intake-flow-hint" className="hint">
            {locked ? t.pipeline.flowLocked : t.pipeline.flowHint}
          </span>
        </div>
        {flow && (
          <p className="hint" data-testid="flow-stages">
            {t.pipeline.flowStages(flow.stages.map((s) => `${s.stage} · ${s.label} (${s.skill})`).join(', '))}
          </p>
        )}
      </div>

      <div className="card">
        <div className="field row">
          <label htmlFor="intake-project">{t.pipeline.project}</label>
          {projects.length === 0 ? (
            <p className="hint">{t.pipeline.noProjects}</p>
          ) : (
            <select id="intake-project" value={project ?? ''} onChange={(e) => onProject(e.target.value)}>
              {projects.map((p) => (
                <option key={p} value={p}>
                  {projectName(p)} — {p}
                </option>
              ))}
            </select>
          )}
        </div>

        {damaged && (
          <p className="banner error-banner" role="alert" data-testid="intake-damaged">
            {t.pipeline.damaged}
          </p>
        )}
        {existing && status && (
          <div className="banner info resume-banner" data-testid="resume-banner">
            <p>{t.pipeline.resumeBanner(describeStop(status), flow?.name ?? status.flow ?? '')}</p>
            <button type="button" className="btn primary" disabled={starting || status.next.kind === 'complete'} onClick={() => void resume()}>
              {starting ? t.pipeline.resuming : t.pipeline.resume}
            </button>
          </div>
        )}
      </div>

      <h2 id="intake-entries">{t.pipeline.inputs}</h2>
      <p className="hint">{t.pipeline.inputsHint}</p>

      <div className="dropzone" data-testid="dropzone">
        <p className="drop-title">{t.pipeline.drop}</p>
        <p className="hint">
          {t.pipeline.or}{' '}
          <button type="button" className="btn" onClick={() => void pick()}>
            {t.pipeline.choose}
          </button>
        </p>
        <p className="hint">{t.pipeline.hint}</p>
      </div>

      {rows.length > 0 && (
        <section aria-label={t.pipeline.list}>
          {existing && <p className="hint">{t.pipeline.adding}</p>}
          <ul className="inputs" aria-label={t.pipeline.list}>
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
                    {item && <span className={`chip class-${item.class}`}>{t.pipeline.class[item.class] ?? item.class}</span>}
                    {item && <span className="hint">{humanSize(item.size)}</span>}
                    {state === 'loading' && <span className="hint">{project ? t.pipeline.checkingFile : t.pipeline.waitingProject}</span>}
                    <button type="button" className="icon-btn" aria-label={t.pipeline.remove(name)} title={t.pipeline.remove(name)} onClick={() => setRows((cur) => removeRow(cur, row.path))}>
                      ×
                    </button>
                  </div>
                  {state === 'ok' && item?.handledBy && <p className="hint">{t.pipeline.readBy(item.handledBy)}</p>}
                  {state === 'ok' && item && item.warnings.length > 0 && (
                    <ul className="warnings">
                      {item.warnings.map((w) => (
                        <li key={w} className="hint">
                          {t.pipeline.warning}: {w}
                        </li>
                      ))}
                    </ul>
                  )}
                  {problem && (
                    <p className="error problem" role="alert">
                      <strong>{t.pipeline.notReadable}:</strong> {problem}
                    </p>
                  )}
                  {item?.class === 'recording' && (
                    <div className="transcript">
                      {!row.transcript && <p className="hint">{t.pipeline.recordingNote}</p>}
                      {row.transcript ? (
                        <p className="hint">
                          {t.pipeline.transcriptOf(row.transcript.item?.name ?? fileName(row.transcript.path))}
                          {row.transcript.item?.handledBy ? ` · ${t.pipeline.readBy(row.transcript.item.handledBy)}` : ''}{' '}
                          <button type="button" className="icon-btn" aria-label={t.pipeline.removeTranscript(row.transcript.item?.name ?? fileName(row.transcript.path))} onClick={() => setRows((cur) => applyTranscript(cur, row.path, undefined))}>
                            ×
                          </button>
                        </p>
                      ) : (
                        <button type="button" className="btn small" onClick={() => void attachTranscript(row)}>
                          {t.pipeline.attachTranscript}
                        </button>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {problems.length > 0 && (
        <div className="banner error-banner" role="alert" data-testid="start-refused">
          <p>{t.pipeline.refused}</p>
          <ul>
            {problems.map((p, i) => (
              <li key={`${p.path}:${i}`}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <p className="banner error-banner" role="alert">
          {t.pipeline.startFailed(error)}
        </p>
      )}

      <div className="intake-actions">
        <button type="button" className="btn primary" disabled={!!blocked || !project || !!damaged || starting} aria-describedby={blocked ? 'intake-why' : undefined} onClick={() => void start()}>
          {starting ? t.pipeline.starting : t.pipeline.start}
        </button>
        {blocked && (
          <span id="intake-why" className="hint">
            {blocked}
          </span>
        )}
      </div>
    </section>
  );
}
