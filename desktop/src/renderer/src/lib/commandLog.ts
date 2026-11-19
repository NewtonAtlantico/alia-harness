import { bashOutcome, type BashOutcome, type Row, type ToolRow } from './timeline';

export interface LoggedCommand {
  id: string;
  command: string;
  /** The command's output as the tool returned it (empty while it runs). */
  output: string;
  outcome: BashOutcome;
  durationMs?: number;
  /** It was run by a subagent, not by the main agent. */
  viaSubagent: boolean;
}

/** The shell commands of a conversation, oldest first, subagents' included: the Terminal tab's read-only log. */
export function collectCommands(rows: Row[]): LoggedCommand[] {
  const out: LoggedCommand[] = [];
  const walk = (list: ToolRow[], viaSubagent: boolean) => {
    for (const t of list) {
      if (t.name === 'run_bash') {
        out.push({
          id: t.id,
          command: String(t.args.command ?? ''),
          output: t.result ?? '',
          outcome: bashOutcome(t),
          durationMs: t.durationMs,
          viaSubagent,
        });
      }
      if (t.children.length > 0) walk(t.children, true);
    }
  };
  walk(rows.filter((r): r is ToolRow => r.kind === 'tool'), false);
  return out;
}
