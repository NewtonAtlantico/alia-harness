import { useCallback, useEffect, useRef, useState } from 'react';
import type { ActiveSession, ChatMessage, OpenedSession, PipelineBrief, SearchHit, SessionInfo } from '../../../shared/ipc';
import { fromActive, projectMarks, reduceSessionStates, type SessionState, type SessionStates } from '../lib/sessionStates';

const STORAGE_KEY = 'alia.currentProject';
const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/** localStorage may be unavailable (private mode, blocked): the app works without it. */
function remembered(): string | undefined {
  try {
    return window.localStorage.getItem(STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
function remember(projectPath: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, projectPath);
  } catch {
    /* ignore */
  }
}

export interface OpenConversation {
  info: SessionInfo;
  opened: OpenedSession;
  messages: ChatMessage[];
}

export interface TrustPrompt {
  projectPath: string;
  skills: string[];
}

const same = (a: string, b: string) => a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');

/**
 * Everything the sidebar and the home screen need: the projects, the conversations of the current one, search,
 * pipelines, which conversations are running or waiting, trust, and the conversation that is open.
 */
export function useWorkspace(onNewConversation?: () => void) {
  const [projects, setProjects] = useState<string[]>([]);
  const [currentProject, setCurrentProject] = useState<string>();
  const [conversations, setConversations] = useState<SessionInfo[]>([]);
  const [pipelines, setPipelines] = useState<Record<string, PipelineBrief>>({});
  const [states, setStates] = useState<SessionStates>({});
  const [activeList, setActiveList] = useState<ActiveSession[]>([]);
  const [open, setOpen] = useState<OpenConversation>();
  const [opening, setOpening] = useState(false);
  const [query, setQueryState] = useState('');
  const [results, setResults] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [trustPrompt, setTrustPrompt] = useState<TrustPrompt>();
  const [error, setError] = useState<string>();

  const current = useRef<string | undefined>(undefined);
  const openRef = useRef<OpenConversation | undefined>(undefined);
  const pendingOpen = useRef<SessionInfo | undefined>(undefined);
  current.current = currentProject;
  openRef.current = open;

  const api = window.alia.request;
  const fail = (err: unknown) => setError(errorText(err));

  const refreshConversations = useCallback(async (project = current.current) => {
    if (!project) return setConversations([]);
    try {
      setConversations(await api('conversations.list', { projectPath: project }));
    } catch (err) {
      setConversations([]);
      fail(err);
    }
  }, []);

  const refreshPipelines = useCallback(async (list: string[]) => {
    const entries = await Promise.all(list.map(async (p) => [p, await api('pipeline.brief', { projectPath: p }).catch(() => undefined)] as const));
    setPipelines(Object.fromEntries(entries.filter((e): e is readonly [string, PipelineBrief] => !!e[1])));
  }, []);

  const refreshActive = useCallback(async () => {
    try {
      const list = await api('sessions.active', {});
      setActiveList(list);
      setStates((prev) => ({ ...fromActive(list), ...Object.fromEntries(Object.entries(prev).filter(([id]) => list.some((s) => s.sessionId === id))) }));
    } catch {
      /* the engine may be restarting */
    }
  }, []);

  const refreshProjects = useCallback(async () => {
    const list = await api('projects.recent', {});
    setProjects(list);
    refreshPipelines(list);
    return list;
  }, [refreshPipelines]);

  // Start-up: the projects, the one used last, and what is already running.
  useEffect(() => {
    (async () => {
      const list = await refreshProjects();
      const last = remembered();
      const first = last && list.some((p) => same(p, last)) ? list.find((p) => same(p, last)) : list[0];
      if (first) {
        setCurrentProject(first);
        current.current = first;
        await refreshConversations(first);
      }
      await refreshActive();
    })().catch(fail);
  }, []);

  const loadOpen = useCallback(async (info: SessionInfo, opened: OpenedSession) => {
    const content = await api('conversations.load', { id: info.id });
    setOpen({ info: content?.info ?? info, opened, messages: content?.messages ?? [] });
  }, []);

  // What the engine pushes: running and waiting marks, and a reason to refresh lists when a run starts or ends.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.alia.onMessage((m) => {
      setStates((prev) => reduceSessionStates(prev, m));
      if (m.kind === 'command') {
        if (m.command === 'new_conversation') newConversation();
        if (m.command === 'open_project') void openFolder();
        return;
      }
      if (m.kind === 'engine_status' && m.status === 'restarted') {
        // Conversations that were open in the engine are gone from memory; the open one is reopened from disk.
        const was = openRef.current;
        void refreshActive();
        if (was) void api('session.open', { projectPath: was.info.workspace, resumeId: was.info.id }).then((o) => loadOpen(was.info, o)).catch(fail);
        return;
      }
      const isRunEdge = m.kind === 'event' && !m.event.subagentId && (m.event.type === 'run_started' || m.event.type === 'run_finished');
      if (isRunEdge || m.kind === 'interaction' || m.kind === 'interaction_closed') {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void refreshActive();
          void refreshConversations();
          void refreshPipelines(projectsRef.current);
          const o = openRef.current;
          if (o && m.kind === 'event' && 'sessionId' in m && m.sessionId === o.info.id && m.event.type === 'run_finished') void api('conversations.load', { id: o.info.id }).then((c) => c && setOpen({ ...o, info: c.info, messages: c.messages }));
        }, 150);
      }
    });
    const onFocus = () => void refreshPipelines(projectsRef.current);
    window.addEventListener('focus', onFocus);
    return () => {
      off();
      window.removeEventListener('focus', onFocus);
      clearTimeout(timer);
    };
  }, []);

  const projectsRef = useRef<string[]>([]);
  projectsRef.current = projects;

  // ---- actions

  const commitProject = useCallback(
    async (projectPath: string) => {
      setCurrentProject(projectPath);
      current.current = projectPath;
      remember(projectPath);
      if (openRef.current && !same(openRef.current.info.workspace, projectPath)) setOpen(undefined);
      await refreshConversations(projectPath);
    },
    [refreshConversations]
  );

  const openConversation = useCallback(
    async (info: SessionInfo) => {
      setError(undefined);
      setOpening(true);
      try {
        let opened = await api('session.open', { projectPath: info.workspace, resumeId: info.id });
        // The folder was trusted after this conversation was opened: reopen it so the project's skills load.
        if (opened.projectSkills.found > 0 && !opened.projectSkills.loaded) {
          const inspection = await api('projects.inspect', { projectPath: info.workspace });
          if (inspection.trust === 'trusted') {
            await api('session.close', { sessionId: info.id });
            opened = await api('session.open', { projectPath: info.workspace, resumeId: info.id });
          }
        }
        await loadOpen(info, opened);
        void refreshActive();
      } catch (err) {
        fail(err);
      } finally {
        setOpening(false);
      }
    },
    [loadOpen, refreshActive]
  );

  const selectProject = useCallback(
    async (projectPath: string, then?: SessionInfo) => {
      setError(undefined);
      try {
        const inspection = await api('projects.inspect', { projectPath });
        if (inspection.trust === 'unknown' && inspection.projectSkills.length > 0) {
          pendingOpen.current = then;
          setTrustPrompt({ projectPath, skills: inspection.projectSkills });
          return;
        }
        await commitProject(projectPath);
        if (then) await openConversation(then);
      } catch (err) {
        fail(err);
      }
    },
    [commitProject, openConversation]
  );

  const answerTrust = useCallback(
    async (trusted: boolean) => {
      const prompt = trustPrompt;
      if (!prompt) return;
      setTrustPrompt(undefined);
      try {
        await api('projects.setTrust', { projectPath: prompt.projectPath, trusted });
        await commitProject(prompt.projectPath);
        const then = pendingOpen.current;
        pendingOpen.current = undefined;
        if (then) await openConversation(then);
      } catch (err) {
        fail(err);
      }
    },
    [trustPrompt, commitProject, openConversation]
  );

  const openFolder = useCallback(async () => {
    setError(undefined);
    try {
      const picked = await api('projects.pick', {});
      if (!picked) return;
      await refreshProjects();
      await selectProject(picked.path);
    } catch (err) {
      fail(err);
    }
  }, [refreshProjects, selectProject]);

  const newConversation = useCallback(() => {
    setOpen(undefined);
    setQueryState('');
    setResults(null);
    onNewConversation?.();
  }, [onNewConversation]);

  const rename = useCallback(
    async (info: SessionInfo, title: string) => {
      try {
        const updated = await api('conversations.rename', { id: info.id, title });
        await refreshConversations();
        setOpen((o) => (o && o.info.id === info.id ? { ...o, info: updated } : o));
      } catch (err) {
        fail(err);
      }
    },
    [refreshConversations]
  );

  const remove = useCallback(
    async (info: SessionInfo) => {
      try {
        await api('conversations.delete', { id: info.id });
        if (openRef.current?.info.id === info.id) setOpen(undefined);
        await refreshConversations();
        void refreshActive();
      } catch (err) {
        fail(err);
      }
    },
    [refreshConversations, refreshActive]
  );

  // Search across every project, once the user pauses typing.
  const setQuery = useCallback((text: string) => {
    setQueryState(text);
    if (!text.trim()) {
      setResults(null);
      setSearching(false);
    }
  }, []);
  useEffect(() => {
    const text = query.trim();
    if (!text) return;
    setSearching(true);
    const timer = setTimeout(() => {
      api('conversations.search', { text })
        .then((hits) => query.trim() === text && setResults(hits))
        .catch(fail)
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const marks: Record<string, SessionState> = projectMarks(activeList, states, projects);

  return {
    projects,
    currentProject,
    conversations,
    pipelines,
    states,
    projectMarks: marks,
    open,
    opening,
    query,
    results,
    searching,
    trustPrompt,
    error,
    actions: { openFolder, selectProject, newConversation, openConversation, rename, remove, setQuery, answerTrust, refreshProjects, dismissError: () => setError(undefined) },
  };
}
