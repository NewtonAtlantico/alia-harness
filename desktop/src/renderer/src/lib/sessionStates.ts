import type { ActiveSession, PushMessage } from '../../../shared/ipc';

/** What the sidebar shows for a conversation: a spinner while it runs, an orange dot while it waits for the user. */
export interface SessionState {
  running: boolean;
  /** Approvals or questions waiting for an answer. */
  waiting: number;
}

export type SessionStates = Readonly<Record<string, SessionState>>;

const idle: SessionState = { running: false, waiting: 0 };

/** The state of a conversation, idle if nothing is known. */
export const stateOf = (states: SessionStates, sessionId: string): SessionState => states[sessionId] ?? idle;

/** Starts from the engine's own list (after loading the page, or after the engine restarted). */
export function fromActive(active: ActiveSession[]): SessionStates {
  return Object.fromEntries(active.map((a) => [a.sessionId, { running: a.running, waiting: a.waiting }]));
}

/** Folds one pushed message into the states. Events of a subagent do not end or start the conversation's run. */
export function reduceSessionStates(states: SessionStates, message: PushMessage): SessionStates {
  switch (message.kind) {
    case 'event': {
      const event = message.event;
      if (event.subagentId) return states;
      if (event.type === 'run_started') return { ...states, [message.sessionId]: { ...stateOf(states, message.sessionId), running: true } };
      if (event.type === 'run_finished') return { ...states, [message.sessionId]: { running: false, waiting: 0 } };
      return states;
    }
    // Approvals and questions are not counted here: the pending list is the one source of truth for what is
    // waiting (see `withWaiting`), so an answer given in the page takes effect at once.
    case 'engine_status':
      // The engine process died or restarted: its conversations are gone until they are opened again.
      return message.status === 'down' ? {} : states;
    default:
      return states;
  }
}

/**
 * The states as the sidebar shows them: what is waiting for the user comes from the list of pending approvals and
 * questions (the one source of truth: an answered card leaves it at once, a cancelled run's cards are closed), and a
 * conversation with something waiting is, of course, still running.
 */
export function withWaiting(states: SessionStates, pending: ReadonlyArray<{ sessionId: string }>): SessionStates {
  const waiting: Record<string, number> = {};
  for (const p of pending) waiting[p.sessionId] = (waiting[p.sessionId] ?? 0) + 1;
  const out: Record<string, SessionState> = {};
  for (const id of new Set([...Object.keys(states), ...Object.keys(waiting)])) {
    const n = waiting[id] ?? 0;
    out[id] = { running: (states[id]?.running ?? false) || n > 0, waiting: n };
  }
  return out;
}

const sameFolder = (a: string, b: string) => a.toLowerCase().replace(/[\\/]+$/, '') === b.toLowerCase().replace(/[\\/]+$/, '');

/** For each project, whether anything in it is running or waiting for the user (a badge on the project in the sidebar). */
export function projectMarks(active: ActiveSession[], states: SessionStates, projects: string[]): Record<string, SessionState> {
  const marks: Record<string, SessionState> = {};
  for (const project of projects) {
    let running = false;
    let waiting = 0;
    for (const s of active) {
      if (!sameFolder(s.workspace, project)) continue;
      const st = stateOf(states, s.sessionId);
      running ||= st.running;
      waiting += st.waiting;
    }
    marks[project] = { running, waiting };
  }
  return marks;
}
