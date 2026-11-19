import { useEffect, useRef } from 'react';
import { t } from '../i18n/pt-BR';
import { collectCommands } from '../lib/commandLog';
import { formatDuration, type Row } from '../lib/timeline';

function badge(c: ReturnType<typeof collectCommands>[number]): { text: string; tone: string } | null {
  switch (c.outcome.state) {
    case 'running':
      return { text: t.timeline.status.running, tone: 'run' };
    case 'passed':
      return { text: t.timeline.status.passed, tone: 'ok' };
    case 'failed':
      return { text: t.timeline.status.failed(c.outcome.exitCode), tone: 'bad' };
    case 'cancelled':
      return { text: t.timeline.status.cancelled, tone: 'muted' };
    case 'timeout':
      return { text: t.timeline.status.timeout, tone: 'bad' };
    case 'denied':
      return { text: t.timeline.status.denied, tone: 'muted' };
    case 'error':
      return { text: t.timeline.status.error, tone: 'bad' };
    default:
      return null;
  }
}

/** The shell commands the agent ran in this conversation, with their output and how each ended. A log: nothing here can be typed into. */
export function TerminalTab({ rows }: { rows: Row[] }) {
  const commands = collectCommands(rows);
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = end.current?.parentElement;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [commands.length, commands.at(-1)?.output]);

  return (
    <div
      className="terminal-tab"
      role="log"
      aria-label={t.panel.terminal.label}
      tabIndex={0}
      data-testid="terminal"
      onScroll={(e) => {
        const el = e.currentTarget;
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {commands.length === 0 ? (
        <p className="hint term-note">{t.panel.terminal.none}</p>
      ) : (
        commands.map((c) => {
          const b = badge(c);
          return (
            <div key={c.id} className="term-entry" data-command={c.command}>
              <div className="term-cmd">
                <span className="prompt" aria-hidden="true">$</span> <code>{c.command}</code>
                {c.viaSubagent && <span className="chip small">{t.panel.terminal.viaSubagent}</span>}
                {b && <span className={`badge ${b.tone}`}>{b.text}</span>}
                {c.durationMs !== undefined && <span className="term-time">{formatDuration(c.durationMs)}</span>}
              </div>
              <pre className="term-out">{c.outcome.state === 'running' ? t.panel.terminal.running : c.output || t.panel.terminal.noOutput}</pre>
            </div>
          );
        })
      )}
      <p className="hint term-note">{t.panel.terminal.readOnly}</p>
      <div ref={end} />
    </div>
  );
}
