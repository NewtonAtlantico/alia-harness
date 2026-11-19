import { useCallback, useEffect, useState } from 'react';
import type { PipelineView } from '../../../shared/ipc';

/**
 * The pipeline of a project as the run view shows it, read again whenever `refreshKey` changes (a run started or ended,
 * a tool call finished) and when the window gets the focus back. `reload` is for after the user changed something.
 */
export function usePipelineView(project: string, enabled: boolean, refreshKey: string) {
  const [view, setView] = useState<PipelineView>();

  const reload = useCallback(async () => {
    if (!enabled) return;
    try {
      setView(await window.alia.request('pipeline.state', { projectPath: project }));
    } catch {
      /* the engine may be restarting: the next refresh will do */
    }
  }, [enabled, project]);

  useEffect(() => {
    void reload();
  }, [reload, refreshKey]);

  useEffect(() => {
    if (!enabled) return;
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled, reload]);

  return { view, reload };
}
