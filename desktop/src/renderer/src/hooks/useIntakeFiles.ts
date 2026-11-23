import { useCallback, useEffect, useRef, useState } from 'react';
import { addPaths, applyInspection, applyTranscript, type IntakeRow } from '../lib/intake';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

export interface IntakeFilesOptions {
  /** The project the files are for. */
  project?: string;
  /** The files cannot be looked at until there is a project (the technical intake); the simple view has none until it starts. */
  needsProject: boolean;
  /** The flow whose skills read the files: another flow reads them again. */
  flow: string;
  rows: IntakeRow[];
  setRows: (update: (rows: IntakeRow[]) => IntakeRow[]) => void;
  /** Files were added or a transcript attached: whatever was said about a refused start no longer holds. */
  onChange: () => void;
  onError: (message: string | undefined) => void;
}

/**
 * The files of a new pipeline, in both views: the ones the user chooses or drops on the window (each looked at by the engine, which
 * says what it is and which skill reads it), the transcript attached to a recording, and the highlight while files are dragged over.
 */
export function useIntakeFiles({ project, needsProject, flow, rows, setRows, onChange, onError }: IntakeFilesOptions) {
  const [dropping, setDropping] = useState(false);
  const api = window.alia.request;
  const projectRef = useRef(project);
  projectRef.current = project;
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const flowRef = useRef(flow);
  flowRef.current = flow;
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const errorRef = useRef(onError);
  errorRef.current = onError;

  const inspect = useCallback(
    async (paths: string[]) => {
      const where = projectRef.current;
      if ((needsProject && !where) || paths.length === 0) return;
      try {
        const { items } = await api('pipeline.inspect', { ...(where ? { projectPath: where } : {}), paths, flow: flowRef.current });
        setRows((cur) => applyInspection(cur, paths, items));
      } catch (err) {
        setRows((cur) => applyInspection(cur, paths, { error: errorText(err) }));
      }
    },
    [api, needsProject, setRows]
  );

  // Files added before a project was open could not be checked (the engine only reads inside the project or what the user chose for it).
  // Check them as soon as there is one.
  useEffect(() => {
    if (!project) return;
    const waiting = rowsRef.current.filter((r) => r.loading).map((r) => r.path);
    if (waiting.length > 0) void inspect(waiting);
  }, [project, inspect]);

  // Which skill reads a file depends on the flow: when the flow changes, the files are looked at again.
  const seenFlow = useRef(flow);
  useEffect(() => {
    if (seenFlow.current === flow) return;
    seenFlow.current = flow;
    const paths = rowsRef.current.map((r) => r.path);
    if (paths.length === 0 || (needsProject && !projectRef.current)) return;
    setRows((cur) => cur.map((r) => ({ ...r, loading: true, item: undefined, failed: undefined })));
    void inspect(paths);
  }, [flow, inspect, needsProject, setRows]);

  const addFiles = useCallback(
    (paths: string[]) => {
      // What is new is decided from the list as last rendered plus what was just asked for; the list itself is updated from its latest value.
      const { added, rows: next } = addPaths(rowsRef.current, paths);
      rowsRef.current = next;
      setRows((cur) => addPaths(cur, paths).rows);
      void inspect(added);
      changeRef.current();
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

  const pick = useCallback(async () => {
    errorRef.current(undefined);
    try {
      const { paths } = await api('attachments.pick', {});
      if (paths.length > 0) addFiles(paths);
    } catch (err) {
      errorRef.current(errorText(err));
    }
  }, [addFiles, api]);

  const attachTranscript = useCallback(
    async (row: IntakeRow) => {
      errorRef.current(undefined);
      try {
        const { paths } = await api('attachments.pick', {});
        const chosen = paths[0];
        const where = projectRef.current;
        if (!chosen || (needsProject && !where)) return;
        setRows((cur) => applyTranscript(cur, row.path, { path: chosen, loading: true }));
        try {
          const { items } = await api('pipeline.inspect', { ...(where ? { projectPath: where } : {}), paths: [chosen], flow: flowRef.current });
          setRows((cur) => applyTranscript(cur, row.path, { path: chosen, item: items[0] }));
        } catch (err) {
          setRows((cur) => applyTranscript(cur, row.path, { path: chosen, failed: errorText(err) }));
        }
        changeRef.current();
      } catch (err) {
        errorRef.current(errorText(err));
      }
    },
    [api, needsProject, setRows]
  );

  return { addFiles, pick, attachTranscript, dropping };
}
