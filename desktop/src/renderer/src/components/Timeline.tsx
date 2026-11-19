import { useId, useState } from 'react';
import { t } from '../i18n/pt-BR';
import {
  baseName,
  bashOutcome,
  formatDuration,
  groupReads,
  summarizeTool,
  type AssistantRow,
  type DisplayItem,
  type LocalRow,
  type NoticeRow,
  type ReadGroup,
  type Row,
  type ThinkingRow,
  type TimelineState,
  type ToolRow,
  type ToolSummary,
  type UserRow,
} from '../lib/timeline';
import { Markdown } from './Markdown';

const OUTPUT_LIMIT = 20_000;
const USER_COLLAPSE_AT = 700;

function titleOf(s: ToolSummary): string {
  switch (s.kind) {
    case 'read':
      return t.timeline.tools.readOne(baseName(s.target));
    case 'list':
      return t.timeline.tools.list(s.target);
    case 'search':
      return t.timeline.tools.search(s.target);
    case 'edit':
      return t.timeline.tools.edit(s.target);
    case 'write':
      return t.timeline.tools.write(s.target);
    case 'bash':
      return t.timeline.tools.bash(s.target);
    case 'skill':
      return t.timeline.tools.skill(s.target);
    case 'subagent':
      return t.timeline.tools.subagent(s.target);
    case 'pipeline':
      return s.action === 'update' ? t.timeline.tools.pipelineUpdate : t.timeline.tools.pipelineGet;
    case 'ask':
      return t.timeline.tools.ask;
    default:
      return t.timeline.tools.other(s.name);
  }
}

/** The small status tag at the end of a tool row, and the tone that colors it. */
function badgeOf(row: ToolRow): { text: string; tone: 'ok' | 'bad' | 'muted' | 'run' } | null {
  if (row.name === 'run_bash') {
    const o = bashOutcome(row);
    switch (o.state) {
      case 'running':
        return { text: t.timeline.status.running, tone: 'run' };
      case 'passed':
        return { text: t.timeline.status.passed, tone: 'ok' };
      case 'failed':
        return { text: t.timeline.status.failed(o.exitCode), tone: 'bad' };
      case 'cancelled':
        return { text: t.timeline.status.cancelled, tone: 'muted' };
      case 'timeout':
        return { text: t.timeline.status.timeout, tone: 'bad' };
      case 'denied':
        return { text: t.timeline.status.denied, tone: 'muted' };
      default:
        return { text: t.timeline.status.error, tone: 'bad' };
    }
  }
  if (row.subagent) {
    const status = row.subagent.status;
    const text = t.timeline.subagentStatus[status] ?? status;
    return { text, tone: status === 'running' ? 'run' : status === 'completed' || status === 'done' ? 'ok' : status === 'cancelled' ? 'muted' : 'bad' };
  }
  if (row.status === 'running') return { text: t.timeline.status.running, tone: 'run' };
  if (row.status === 'error') return { text: t.timeline.status.error, tone: 'bad' };
  if (row.status === 'cancelled') return { text: t.timeline.status.cancelled, tone: 'muted' };
  return null;
}

const clip = (s: string) => (s.length > OUTPUT_LIMIT ? `${s.slice(0, OUTPUT_LIMIT)}\n… (${(s.length - OUTPUT_LIMIT).toLocaleString('pt-BR')} caracteres a mais)` : s);

function ToolBlock({ row }: { row: ToolRow }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const summary = summarizeTool(row);
  const badge = badgeOf(row);
  const hasArgs = Object.keys(row.args).length > 0;
  const stats = (summary.kind === 'edit' || summary.kind === 'write') && summary.added !== undefined ? summary : undefined;

  return (
    <li className={`tool ${row.status}`} data-tool={row.name} data-status={row.status}>
      <button type="button" className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)} title={open ? t.timeline.hideOutput : t.timeline.showOutput}>
        <span className={`tool-icon ${row.status === 'running' ? 'mark spinner' : ''}`} aria-hidden="true">
          {row.status === 'running' ? '' : open ? '▾' : '▸'}
        </span>
        <span className="tool-title">{titleOf(summary)}</span>
        {stats && (
          <span className="tool-stats">
            <span className="add">+{stats.added}</span> <span className="rem">−{stats.removed}</span>
          </span>
        )}
        {badge && <span className={`badge ${badge.tone}`}>{badge.text}</span>}
        {row.durationMs !== undefined && <span className="hint tool-time">{formatDuration(row.durationMs)}</span>}
      </button>
      {open && (
        <div id={bodyId} className="tool-body">
          {hasArgs && row.name !== 'run_bash' && (
            <>
              <h4>{t.timeline.arguments}</h4>
              <pre>{clip(JSON.stringify(row.args, null, 2))}</pre>
            </>
          )}
          <h4>{t.timeline.result}</h4>
          <pre>{row.result ? clip(row.result) : t.timeline.noOutput}</pre>
        </div>
      )}
      {row.subagent && row.children.length > 0 && (
        <ol className="tool-children" aria-label={titleOf(summary)}>
          {row.children.map((c) => (
            <ToolBlock key={c.id} row={c} />
          ))}
        </ol>
      )}
    </li>
  );
}

function ReadsBlock({ group }: { group: ReadGroup }) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  const running = group.rows.some((r) => r.status === 'running');
  const failed = group.rows.filter((r) => r.status === 'error').length;
  const title = group.rows.length === 1 ? t.timeline.tools.readOne(baseName(String(group.rows[0].args.path ?? ''))) : t.timeline.tools.read(group.rows.length);
  return (
    <li className={`tool reads ${running ? 'running' : 'done'}`} data-tool="reads" data-count={group.rows.length}>
      <button type="button" className="tool-head" aria-expanded={open} aria-controls={bodyId} onClick={() => setOpen(!open)}>
        <span className={`tool-icon ${running ? 'mark spinner' : ''}`} aria-hidden="true">
          {running ? '' : open ? '▾' : '▸'}
        </span>
        <span className="tool-title">{title}</span>
        {failed > 0 && <span className="badge bad">{t.timeline.status.error}</span>}
      </button>
      {open && (
        <ul id={bodyId} className="tool-body read-list">
          {group.rows.map((r) => (
            <li key={r.id} className={r.status === 'error' ? 'bad' : ''}>
              <code>{String(r.args.path ?? '')}</code>
              {r.status === 'error' && <span className="hint"> — {r.result}</span>}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function UserBlock({ row }: { row: UserRow }) {
  const [expanded, setExpanded] = useState(false);
  const long = row.text.length > USER_COLLAPSE_AT;
  return (
    <li className="turn user">
      <strong className="who">{t.timeline.you}</strong>
      <div className="bubble user-bubble">
        {long && !expanded ? `${row.text.slice(0, USER_COLLAPSE_AT)}…` : row.text}
        {long && (
          <button type="button" className="link-btn" onClick={() => setExpanded(!expanded)}>
            {expanded ? t.timeline.showLess : t.timeline.showMore}
          </button>
        )}
      </div>
    </li>
  );
}

function AssistantBlock({ row }: { row: AssistantRow }) {
  return (
    <li className={`turn assistant ${row.final ? 'final' : 'aside'}`} data-final={row.final}>
      {row.final && <strong className="who">{t.timeline.assistant}</strong>}
      <div className="bubble assistant-bubble">
        <Markdown text={row.text} />
      </div>
    </li>
  );
}

function ThinkingBlock({ row }: { row: ThinkingRow }) {
  return (
    <li className="thinking">
      <details>
        <summary>{t.timeline.reasoning}</summary>
        <p>{row.text}</p>
      </details>
    </li>
  );
}

function NoticeBlock({ row }: { row: NoticeRow }) {
  let text: string;
  switch (row.code) {
    case 'cancelled':
      text = t.timeline.notices.cancelled;
      break;
    case 'failed':
      text = t.timeline.notices.failed(row.message);
      break;
    case 'max_steps':
      text = t.timeline.notices.maxSteps;
      break;
    case 'compacted':
      text = t.timeline.notices.compacted(row.tokensBefore, row.tokensAfter);
      break;
    default:
      text = row.message;
  }
  const tone = row.code === 'error' || row.code === 'failed' || row.code === 'max_steps' ? 'bad' : row.code === 'success' ? 'ok' : 'info';
  return (
    <li className={`notice-row ${tone}`} role={tone === 'bad' ? 'alert' : 'status'} data-notice={row.code}>
      {text}
    </li>
  );
}

function LocalBlock({ row }: { row: LocalRow }) {
  return (
    <li className="local-row" data-local={row.command}>
      <strong className="who">/{row.command}</strong>
      <pre>{row.text}</pre>
    </li>
  );
}

function renderItem(item: DisplayItem) {
  switch (item.kind) {
    case 'user':
      return <UserBlock key={item.id} row={item} />;
    case 'assistant':
      return <AssistantBlock key={item.id} row={item} />;
    case 'thinking':
      return <ThinkingBlock key={item.id} row={item} />;
    case 'notice':
      return <NoticeBlock key={item.id} row={item} />;
    case 'local':
      return <LocalBlock key={item.id} row={item} />;
    case 'reads':
      return <ReadsBlock key={item.id} group={item} />;
    default:
      return <ToolBlock key={(item as Row).id} row={item as ToolRow} />;
  }
}

/** The conversation as rows. A live region, so a screen reader hears the answer arrive. */
export function Timeline({ state }: { state: TimelineState }) {
  const items = groupReads(state.rows);
  return (
    <ol className="timeline" role="log" aria-live="polite" aria-label={t.timeline.label}>
      {items.map(renderItem)}
      {state.modelBusy && (
        <li className="thinking-now" role="status" data-testid="thinking">
          <span className="mark spinner" aria-hidden="true" /> {t.timeline.thinking}
        </li>
      )}
    </ol>
  );
}
