import { useCallback, useEffect, useRef, useState } from 'react';
import type { IntakeProblem, PipelineInputRef, PipelineStatus } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { addPaths, applyInspection, applyTranscript, canStart, describeStop, removeRow, rowProblem, rowState, startBlockedReason, toInputs, type IntakeRow } from '../lib/intake';
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
  /** Starts the pipeline with these files. Resolves with the problems when it refused (nothing was written). */
  onStart: (project: string, inputs: PipelineInputRef[]) => Promise<IntakeProblem[] | undefined>;
  onResume: (project: string) => Promise<string | undefined>;
  /** Bumped by the app when a pipeline run starts or ends, so the banner is read again. */
  refreshKey?: unknown;
}

/**
 * "Novo pipeline": the four stages and their gates, the project the pipeline is for, a banner when it already has a state, and the
 * files to start with, each shown with what it is and which skill reads it. Nothing runs until "Iniciar pipeline", and the engine
 * refuses to start (writing nothing) if any file cannot be used.
 */
export function PipelineIntake({ projects, project, onProject, rows, setRows, notice, setNotice, onStart, onResume, refreshKey }: IntakeProps) {
  const [status, setStatus] = useState<PipelineStatus>();
  const [starting, setStarting] = useState(false);
  const { problems, error } = notice;
  const setProblems = (p: IntakeProblem[]) => setNotice({ problems: p });
  const setError = (e: string | undefined) => setNotice({ problems: [], error: e });
  const [dropping, setDropping] = useState(false);
  const api = window.alia.request;
  const projectRef = useRef(project);
  projectRef.current = project;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

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

  const inspect = useCallback(
    async (paths: string[]) => {
      const where = projectRef.current;
      if (!where || paths.length === 0) return;
      try {
        const { items } = await api('pipeline.inspect', { projectPath: where, paths });
        setRows((cur) => applyInspection(cur, paths, items));
      } catch (err) {
        setRows((cur) => applyInspection(cur, paths, { error: errorText(err) }));
      }
    },
    [setRows]
  );

  // Files added before a project was open could not be checked (the engine only reads inside the project or what the user chose for it).
  // Check them as soon as there is one.
  useEffect(() => {
    if (!project) return;
    const waiting = rowsRef.current.filter((r) => r.loading).map((r) => r.path);
    if (waiting.length > 0) void inspect(waiting);
  }, [project, inspect]);

  const addFiles = useCallback(
    (paths: string[]) => {
      // What is new is decided from the list as last rendered plus what was just asked for; the list itself is updated from its latest value.
      const { added, rows: next } = addPaths(rowsRef.current, paths);
      rowsRef.current = next;
      setRows((cur) => addPaths(cur, paths).rows);
      void inspect(added);
      setProblems([]);
    },
    [inspect, setRows]
  );

  // Files dropped on the window (the preload reports a genuine drop and main has told the engine it may read them).
  useEffect(() => window.alia.onMessage((m) => m.kind === 'files_dropped' && addFiles(m.paths)), [addFiles]);

  // A highlight while files are dragged over the window.
  useEffect(() => {
    let depth = 0;
    const has = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => has(e) && (depth++, setDropping(true));
    const leave = (e: DragEvent) => has(e) && (depth = Math.max(0, depth - 1)) === 0 && setDropping(false);
    const end = () => {
      depth = 0;
      setDropping(false);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
    };
  }, []);

  const pick = async () => {
    setError(undefined);
    try {
      const { paths } = await api('attachments.pick', {});
      if (paths.length > 0) addFiles(paths);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const attachTranscript = async (row: IntakeRow) => {
    setError(undefined);
    try {
      const { paths } = await api('attachments.pick', {});
      const chosen = paths[0];
      const where = projectRef.current;
      if (!chosen || !where) return;
      setRows((cur) => applyTranscript(cur, row.path, { path: chosen, loading: true }));
      try {
        const { items } = await api('pipeline.inspect', { projectPath: where, paths: [chosen] });
        setRows((cur) => applyTranscript(cur, row.path, { path: chosen, item: items[0] }));
      } catch (err) {
        setRows((cur) => applyTranscript(cur, row.path, { path: chosen, failed: errorText(err) }));
      }
      setProblems([]);
    } catch (err) {
      setError(errorText(err));
    }
  };

  const start = async () => {
    if (!project || !canStart(rows)) return;
    setStarting(true);
    setError(undefined);
    setProblems([]);
    try {
      const refused = await onStart(project, toInputs(rows));
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
      <h1 id="intake-title" className="display">
        {t.pipeline.title}
      </h1>
      <p className="lead">{t.pipeline.intro}</p>

      <ol className="stages" aria-label={t.pipeline.stagesLabel}>
        {t.pipeline.stages.map((s, i) => (
          <li key={s.name}>
            <span className="stage-n" aria-hidden="true">
              {i + 1}
            </span>
            <span>
              <strong>{s.name}</strong>
              <span className="hint">{s.gate}</span>
            </span>
          </li>
        ))}
      </ol>

      <div className="field">
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
          <p>{t.pipeline.resumeBanner(describeStop(status))}</p>
          <button type="button" className="btn primary" disabled={starting || status.next.kind === 'complete'} onClick={() => void resume()}>
            {starting ? t.pipeline.resuming : t.pipeline.resume}
          </button>
        </div>
      )}

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
        <section aria-labelledby="intake-inputs">
          <h2 id="intake-inputs">{t.pipeline.inputs}</h2>
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
