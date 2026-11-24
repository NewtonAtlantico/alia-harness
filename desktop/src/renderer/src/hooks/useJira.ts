import { useCallback, useEffect, useRef, useState } from 'react';
import type { JiraTarget, McpServerSummary, McpView } from '../../../shared/ipc';
import { jiraServerFor } from '../lib/jira';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

export interface JiraState {
  /** Loaded at least once (so the screen does not flash "Conectar ao Jira" for someone who is connected). */
  loaded: boolean;
  view?: McpView;
  target: JiraTarget | null;
  /** The connected server this project's target names, when there is one: Jira is ready to receive. */
  server?: McpServerSummary;
  ready: boolean;
  reload: () => Promise<void>;
  /** Removes the connection and clears this project's target. Resolves with an error message, or nothing. */
  disconnect: () => Promise<string | undefined>;
}

/** Whether this project can send its tasks to Jira: the saved servers and where the project's tasks go. Loads on mount. */
export function useJira(projectPath: string | undefined): JiraState {
  const [view, setView] = useState<McpView>();
  const [target, setTarget] = useState<JiraTarget | null>(null);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  const pathRef = useRef(projectPath);
  pathRef.current = projectPath;

  const reload = useCallback(async () => {
    const path = pathRef.current;
    const [v, tg] = await Promise.all([
      window.alia.request('mcp.get', {}).catch(() => undefined),
      path ? window.alia.request('jira.getTarget', { projectPath: path }).catch(() => null) : Promise.resolve(null),
    ]);
    if (!alive.current || pathRef.current !== path) return;
    setView(v);
    setTarget(tg);
    setLoaded(true);
  }, []);

  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, [reload, projectPath]);

  const server = jiraServerFor(view, target);

  const disconnect = useCallback(async () => {
    const path = pathRef.current;
    try {
      const id = target?.serverId ?? server?.id;
      if (id) await window.alia.request('mcp.remove', { id });
      if (path) await window.alia.request('jira.setTarget', { projectPath: path, target: null });
      await reload();
      return undefined;
    } catch (err) {
      await reload();
      return errorText(err);
    }
  }, [reload, server, target]);

  return { loaded, view, target, server, ready: !!server && !!target, reload, disconnect };
}
