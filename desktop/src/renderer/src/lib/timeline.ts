/**
 * The chat timeline as data. Events from the engine become rows (the reducer below), and so does a saved
 * conversation (`rowsFromMessages`), so a live run and a reopened conversation look alike. Everything here is pure:
 * no React, no DOM, no clock. The wording lives in the string catalog; this module only decides what the rows are.
 */
import type { AgentEvent, ChatMessage, PushMessage } from '../../../shared/ipc';
import { textOf } from './messageText';

/** Marks a call that was cut off by the Stop button (core's `CANCELLED_OUTPUT_PREFIX`). */
export const CANCELLED_PREFIX = '[Cancelled by user]';
/** Marks a call that was cut off because the app stopped (core's `INTERRUPTED_OUTPUT_PREFIX`). */
export const INTERRUPTED_PREFIX = '[Interrupted]';

export interface ChangeSummary {
  path: string;
  kind: 'created' | 'modified' | 'untracked';
  added: number;
  removed: number;
}

export type ToolStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface UserRow {
  kind: 'user';
  id: string;
  text: string;
}
export interface AssistantRow {
  kind: 'assistant';
  id: string;
  text: string;
  /** False for the text a model writes beside tool calls ("Vou ler o arquivo..."). */
  final: boolean;
}
export interface ThinkingRow {
  kind: 'thinking';
  id: string;
  text: string;
}
export interface NoticeRow {
  kind: 'notice';
  id: string;
  /** What happened; the catalog turns the code into words. `message` carries detail the code does not. */
  code: 'cancelled' | 'failed' | 'max_steps' | 'compacted' | 'error' | 'info' | 'success';
  message: string;
  tokensBefore?: number;
  tokensAfter?: number;
}
export interface ToolRow {
  kind: 'tool';
  id: string;
  name: string;
  args: Record<string, unknown>;
  status: ToolStatus;
  result?: string;
  durationMs?: number;
  changes?: ChangeSummary[];
  /** A `run_subagent` call: the child's id and how it ended. */
  subagent?: { id: string; label: string; status: string; steps?: number; maxSteps?: number };
  /** What a subagent did (its tool calls), nested under the row that started it. */
  children: ToolRow[];
}
/** What a slash command that only the app handles printed (/help, /models, /tokens...). Not part of the saved conversation. */
export interface LocalRow {
  kind: 'local';
  id: string;
  command: string;
  text: string;
}
export type Row = UserRow | AssistantRow | ThinkingRow | NoticeRow | LocalRow | ToolRow;

/** Something the page itself adds to the timeline, besides what the engine pushes. */
export type TimelineAction = PushMessage | { kind: 'local'; command: string; text: string } | { kind: 'cleared' };

export interface TimelineState {
  rows: Row[];
  /** A request to the model is in flight (the spinner). */
  modelBusy: boolean;
  running: boolean;
  seq: number;
  /** The current run has shown its final answer. */
  finalSeen: boolean;
}

export const emptyTimeline: TimelineState = { rows: [], modelBusy: false, running: false, seq: 0, finalSeen: false };

const parseArgs = (raw: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Whether a tool result is a failure, in the words core uses (`Error: ...`, `Error writing file ...`). */
export function isErrorResult(result: string): boolean {
  return /^Error(:| (editing|executing|listing|parsing|performing|reading|writing)\b)/.test(result);
}

function statusOf(result: string, isError: boolean): ToolStatus {
  if (result.startsWith(CANCELLED_PREFIX)) return 'cancelled';
  return isError ? 'error' : 'done';
}

const withSeq = (s: TimelineState, make: (id: string) => Row): TimelineState => ({ ...s, rows: [...s.rows, make(`r${s.seq}`)], seq: s.seq + 1 });

/** Updates the tool row with this id, at the top level or inside a subagent's children. Returns undefined if there is none. */
function mapTool(rows: Row[], id: string, fn: (t: ToolRow) => ToolRow): Row[] | undefined {
  let found = false;
  const walk = (list: Row[]): Row[] =>
    list.map((r) => {
      if (r.kind !== 'tool') return r;
      if (r.id === id) {
        found = true;
        return fn(r);
      }
      if (r.children.length === 0) return r;
      const children = walk(r.children) as ToolRow[];
      return children === r.children ? r : { ...r, children };
    });
  const next = walk(rows);
  return found ? next : undefined;
}

/** Applies a change to the subagent's row (found by the child's id). */
function mapSubagent(rows: Row[], subagentId: string, fn: (t: ToolRow) => ToolRow): Row[] | undefined {
  let found = false;
  const next = rows.map((r) => {
    if (r.kind === 'tool' && r.subagent?.id === subagentId) {
      found = true;
      return fn(r);
    }
    return r;
  });
  return found ? next : undefined;
}

function applyEvent(state: TimelineState, event: AgentEvent): TimelineState {
  const sub = event.subagentId;

  // Work done inside a subagent nests under the call that started it. Only its tool calls are shown.
  if (sub) {
    if (event.type === 'tool_call_started') {
      const child: ToolRow = { kind: 'tool', id: event.id, name: event.name, args: parseArgs(event.args), status: 'running', children: [] };
      const rows = mapSubagent(state.rows, sub, (t) => ({ ...t, children: [...t.children, child] }));
      return rows ? { ...state, rows } : state;
    }
    if (event.type === 'tool_call_finished') {
      const rows = mapSubagent(state.rows, sub, (t) => ({
        ...t,
        children: t.children.map((c) => (c.id === event.id ? { ...c, status: statusOf(event.result, event.isError), result: event.result, durationMs: event.durationMs, ...(event.changes ? { changes: event.changes } : {}) } : c)),
      }));
      return rows ? { ...state, rows } : state;
    }
    return state;
  }

  switch (event.type) {
    case 'run_started':
      return { ...state, running: true, modelBusy: false, finalSeen: false };

    case 'model_started':
      return { ...state, modelBusy: true };
    case 'model_finished':
      return { ...state, modelBusy: false };

    case 'thinking': {
      const last = state.rows.at(-1);
      if (last?.kind === 'thinking') return { ...state, rows: [...state.rows.slice(0, -1), { ...last, text: `${last.text}${event.text}` }] };
      return withSeq(state, (id) => ({ kind: 'thinking', id, text: event.text }));
    }

    case 'assistant_message': {
      if (!event.text.trim()) return state;
      const next = withSeq(state, (id) => ({ kind: 'assistant', id, text: event.text, final: event.final }));
      return event.final ? { ...next, finalSeen: true } : next;
    }

    case 'tool_call_started': {
      // A call announced twice (a retry of the same id) replaces the first instead of doubling it.
      const row: ToolRow = { kind: 'tool', id: event.id, name: event.name, args: parseArgs(event.args), status: 'running', children: [] };
      const replaced = mapTool(state.rows, event.id, () => row);
      return replaced ? { ...state, rows: replaced } : { ...state, rows: [...state.rows, row] };
    }

    case 'tool_call_finished': {
      const patch = (t: ToolRow): ToolRow => ({ ...t, status: statusOf(event.result, event.isError), result: event.result, durationMs: event.durationMs, ...(event.changes ? { changes: event.changes } : {}) });
      const rows = mapTool(state.rows, event.id, patch);
      if (rows) return { ...state, rows };
      // Finished without having been seen start (the page opened mid-run): show it anyway.
      const row = patch({ kind: 'tool', id: event.id, name: event.name, args: {}, status: 'running', children: [] });
      return { ...state, rows: [...state.rows, row] };
    }

    case 'subagent_started': {
      const info = { id: event.id, label: event.label, status: 'running', maxSteps: event.maxSteps };
      const parent = event.parentToolCallId;
      const rows = parent ? mapTool(state.rows, parent, (t) => ({ ...t, subagent: info })) : undefined;
      if (rows) return { ...state, rows };
      const row: ToolRow = { kind: 'tool', id: parent ?? `sub-${event.id}`, name: 'run_subagent', args: { task: event.label }, status: 'running', subagent: info, children: [] };
      return { ...state, rows: [...state.rows, row] };
    }

    case 'subagent_finished': {
      const rows = mapSubagent(state.rows, event.id, (t) => ({ ...t, subagent: { id: event.id, label: event.label, status: event.status, steps: event.steps, maxSteps: event.maxSteps } }));
      return rows ? { ...state, rows } : state;
    }

    case 'context_compacted':
      return withSeq(state, (id) => ({ kind: 'notice', id, code: 'compacted', message: '', tokensBefore: event.tokensBefore, tokensAfter: event.tokensAfter }));

    case 'notice':
      return withSeq(state, (id) => ({ kind: 'notice', id, code: event.level === 'error' ? 'error' : event.level, message: event.message }));

    case 'run_finished': {
      let next: TimelineState = { ...state, running: false, modelBusy: false };
      const { status, text } = event.result;
      if (status === 'cancelled') return withSeq(next, (id) => ({ kind: 'notice', id, code: 'cancelled', message: text }));
      if (status === 'failed' || status === 'max_steps') {
        // Core already reported the reason as an error notice; do not say it twice.
        const last = next.rows.at(-1);
        if (last?.kind === 'notice' && last.message === text) return next;
        return withSeq(next, (id) => ({ kind: 'notice', id, code: status === 'failed' ? 'failed' : 'max_steps', message: text }));
      }
      // A completed run whose answer was not announced as a message still shows it.
      if (!state.finalSeen && text.trim()) next = withSeq(next, (id) => ({ kind: 'assistant', id, text, final: true }));
      return next;
    }

    default:
      return state; // permission_requested / permission_resolved belong to the approval card (A8)
  }
}

/** Folds one pushed message of THIS conversation into the timeline. Messages for other conversations are the caller's to filter. */
export function applyPush(state: TimelineState, message: TimelineAction): TimelineState {
  if (message.kind === 'cleared') return { ...emptyTimeline, seq: state.seq };
  if (message.kind === 'local') return withSeq(state, (id) => ({ kind: 'local', id, command: message.command, text: message.text }));
  if (message.kind === 'user_message') return withSeq(state, (id) => ({ kind: 'user', id, text: message.text }));
  if (message.kind === 'event') return applyEvent(state, message.event);
  return state;
}

/**
 * The timeline of a saved conversation. Durations and change counts are not in the saved messages (A9 adds them).
 * A call with no result is still running if the conversation is (the page opened mid-run: live events will finish it),
 * and otherwise it was cut off.
 */
export function rowsFromMessages(messages: ChatMessage[], options: { running?: boolean } = {}): TimelineState {
  const rows: Row[] = [];
  const byCall = new Map<string, ToolRow>();
  let seq = 0;
  const id = () => `h${seq++}`;

  for (const m of messages) {
    if (m.role === 'user') {
      const text = textOf(m).trim();
      if (text) rows.push({ kind: 'user', id: id(), text });
    } else if (m.role === 'assistant') {
      const text = textOf(m).trim();
      const calls = ('tool_calls' in m && m.tool_calls) || [];
      if (text) rows.push({ kind: 'assistant', id: id(), text, final: calls.length === 0 });
      for (const c of calls) {
        if (c.type !== 'function') continue;
        const row: ToolRow = { kind: 'tool', id: c.id, name: c.function.name, args: parseArgs(c.function.arguments), status: options.running ? 'running' : 'cancelled', children: [] };
        byCall.set(c.id, row);
        rows.push(row);
      }
    } else if (m.role === 'tool') {
      const row = byCall.get(m.tool_call_id);
      if (!row) continue;
      const result = textOf(m);
      row.result = result;
      row.status = result.startsWith(CANCELLED_PREFIX) || result.startsWith(INTERRUPTED_PREFIX) ? 'cancelled' : isErrorResult(result) ? 'error' : 'done';
    }
  }
  return { rows, modelBusy: false, running: options.running === true, seq, finalSeen: true };
}

// ------------------------------------------------------------------------------------ display

export interface ReadGroup {
  kind: 'reads';
  id: string;
  rows: ToolRow[];
}
export type DisplayItem = Row | ReadGroup;

/** Consecutive `read_file` calls become one item ("Leu 3 arquivos"); everything else stays as it is. */
export function groupReads(rows: Row[]): DisplayItem[] {
  const out: DisplayItem[] = [];
  for (const row of rows) {
    if (row.kind === 'tool' && row.name === 'read_file') {
      const last = out.at(-1);
      if (last && last.kind === 'reads') last.rows.push(row);
      else out.push({ kind: 'reads', id: `reads-${row.id}`, rows: [row] });
    } else {
      out.push(row);
    }
  }
  return out;
}

/** How a shell command ended, read from the result text. */
export interface BashOutcome {
  state: 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout' | 'denied' | 'error';
  exitCode?: number;
}

export function bashOutcome(row: Pick<ToolRow, 'status' | 'result'>): BashOutcome {
  if (row.status === 'running') return { state: 'running' };
  const result = row.result ?? '';
  if (row.status === 'cancelled' || result.startsWith(CANCELLED_PREFIX) || result.startsWith(INTERRUPTED_PREFIX)) return { state: 'cancelled' };
  if (/^User denied permission/.test(result) || /^Error: .*denied/i.test(result)) return { state: 'denied' };
  if (/^\[Execution timed out/m.test(result.slice(0, 200))) return { state: 'timeout' };
  const code = /^\[Exit Code: (-?\d+)\]/.exec(result) ?? /\(exit code: (-?\d+)\)/.exec(result);
  if (code) {
    const exitCode = Number(code[1]);
    return { state: exitCode === 0 ? 'passed' : 'failed', exitCode };
  }
  if (row.status === 'error' || isErrorResult(result)) return { state: 'error' };
  return { state: 'passed', exitCode: 0 };
}

export type ToolSummary =
  | { kind: 'read'; target: string }
  | { kind: 'list'; target: string }
  | { kind: 'search'; target: string }
  | { kind: 'edit' | 'write'; target: string; added?: number; removed?: number }
  | { kind: 'bash'; target: string }
  | { kind: 'skill'; target: string }
  | { kind: 'subagent'; target: string }
  | { kind: 'pipeline'; action: 'get' | 'update' }
  | { kind: 'ask' }
  | { kind: 'other'; name: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const shorten = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** What a tool row is about, for its title. Counts come from the change summary when the call wrote a file. */
export function summarizeTool(row: ToolRow): ToolSummary {
  switch (row.name) {
    case 'read_file':
      return { kind: 'read', target: str(row.args.path) };
    case 'list_files':
      return { kind: 'list', target: str(row.args.path) || '.' };
    case 'grep_search':
      return { kind: 'search', target: shorten(str(row.args.pattern) || str(row.args.query), 60) };
    case 'edit_file':
    case 'write_file': {
      const target = str(row.args.path) || row.changes?.[0]?.path || '';
      const change = row.changes?.find((c) => c.kind !== 'untracked') ?? undefined;
      return { kind: row.name === 'edit_file' ? 'edit' : 'write', target, ...(change ? { added: change.added, removed: change.removed } : {}) };
    }
    case 'run_bash':
      return { kind: 'bash', target: shorten(str(row.args.command).replace(/\s+/g, ' ').trim(), 120) };
    case 'use_skill':
      return { kind: 'skill', target: str(row.args.name) };
    case 'run_subagent':
      return { kind: 'subagent', target: shorten(row.subagent?.label || str(row.args.task).split('\n')[0], 100) };
    case 'pipeline_state':
      return { kind: 'pipeline', action: row.args.action === 'update' ? 'update' : 'get' };
    case 'ask_user':
      return { kind: 'ask' };
    default:
      return { kind: 'other', name: row.name };
  }
}

/** The last part of a path (`src/app/main.ts` is `main.ts`). */
export const baseName = (p: string): string => p.split(/[\\/]+/).filter(Boolean).at(-1) ?? p;

/** "1,2 s" / "340 ms" / "2 min 5 s" for a tool call's duration. */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) return '';
  if (ms < 1000) return `${Math.max(0, Math.round(ms))} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0).replace('.', ',')} s`;
  return `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}
