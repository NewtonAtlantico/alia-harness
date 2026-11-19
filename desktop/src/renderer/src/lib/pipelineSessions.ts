/**
 * Which conversations are pipeline runs. A pipeline gets a conversation of its own (A11), and that conversation shows the
 * stepper, the gate card and the pipeline tab. The ids are kept in this browser profile; losing them only costs the extra
 * header, never the pipeline (its state is in the project's docs/pipeline/state.json).
 */
const KEY = 'alia.pipelineSessions';

function read(): string[] {
  try {
    const raw = window.localStorage.getItem(KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export const isPipelineSession = (id: string): boolean => read().includes(id);

export function markPipelineSession(id: string): void {
  try {
    const list = read();
    if (!list.includes(id)) window.localStorage.setItem(KEY, JSON.stringify([...list, id].slice(-200)));
  } catch {
    /* ignore */
  }
}

/** The ids, newest last. */
export const pipelineSessions = (): string[] => read();
