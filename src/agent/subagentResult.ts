/**
 * The text contract between a subagent and its caller:
 *
 *   STATUS: completed | blocked | failed | max_steps
 *   SUMMARY: ...
 *   ARTIFACTS: path, path, ...
 *   QUESTIONS: ...        (only when blocked)
 *
 * Plain text (not JSON) because a small model produces it more reliably; the parser is
 * deliberately lenient about case, bullets, and where the block sits in the final message.
 */

export type SubagentStatus = 'completed' | 'blocked' | 'failed' | 'max_steps';

export interface SubagentReport {
  status: SubagentStatus;
  summary: string;
  artifacts: string[];
  questions: string;
}

/** Hard cap on the text handed back to the parent, so a chatty child can't flood its context. */
export const MAX_RESULT_CHARS = 4000;

const KEYS = ['STATUS', 'SUMMARY', 'ARTIFACTS', 'QUESTIONS'] as const;
type Key = (typeof KEYS)[number];
// Tolerates "**STATUS:**", "- STATUS:", "Status :" etc.
const KEY_LINE = /^[\s>*_`#-]*(STATUS|SUMMARY|ARTIFACTS|QUESTIONS)[\s*_`]*:[\s*_`]*(.*)$/i;

const VALID_STATUS: SubagentStatus[] = ['completed', 'blocked', 'failed', 'max_steps'];

function normalizeStatus(raw: string): SubagentStatus | null {
  const word = raw.toLowerCase().replace(/[^a-z_ ]/g, ' ').trim().split(/\s+/)[0]?.replace(/-/g, '_');
  if (word === 'complete' || word === 'done' || word === 'success') return 'completed';
  return (VALID_STATUS as string[]).includes(word ?? '') ? (word as SubagentStatus) : null;
}

function splitList(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.replace(/^[\s*\-•`'"]+|[\s`'"]+$/g, ''))
    .filter((s) => s && !/^(none|n\/a|-)$/i.test(s));
}

/**
 * Parses the last STATUS block in the child's final message. If the child never produced one
 * (common with small models), the whole message becomes the summary of a `completed` run —
 * the caller still verifies artifacts, so this does not let a fabricated "done" through.
 */
export function parseSubagentReport(finalText: string): SubagentReport {
  const lines = finalText.split(/\r?\n/);

  let start = -1;
  lines.forEach((line, i) => {
    const m = KEY_LINE.exec(line);
    if (m && m[1].toUpperCase() === 'STATUS' && normalizeStatus(m[2])) start = i;
  });

  if (start === -1) {
    return { status: 'completed', summary: finalText.trim(), artifacts: [], questions: '' };
  }

  const fields: Record<Key, string[]> = { STATUS: [], SUMMARY: [], ARTIFACTS: [], QUESTIONS: [] };
  let current: Key | null = null;
  for (const line of lines.slice(start)) {
    const m = KEY_LINE.exec(line);
    if (m) {
      current = m[1].toUpperCase() as Key;
      fields[current].push(m[2]);
    } else if (current) {
      fields[current].push(line);
    }
  }

  const join = (k: Key) => fields[k].join('\n').trim();
  return {
    status: normalizeStatus(join('STATUS')) ?? 'completed',
    summary: join('SUMMARY'),
    artifacts: splitList(join('ARTIFACTS')),
    questions: join('QUESTIONS'),
  };
}

/** Renders a report as the capped text block returned to the parent. */
export function formatSubagentReport(report: SubagentReport, extra: { steps?: number; maxSteps?: number } = {}): string {
  const parts = [`STATUS: ${report.status}`];
  if (extra.steps !== undefined) {
    parts.push(`STEPS: ${extra.steps}${extra.maxSteps !== undefined ? `/${extra.maxSteps}` : ''}`);
  }
  parts.push(`SUMMARY: ${report.summary || '(none)'}`);
  if (report.artifacts.length > 0) parts.push(`ARTIFACTS: ${report.artifacts.join(', ')}`);
  if (report.questions) parts.push(`QUESTIONS: ${report.questions}`);

  const text = parts.join('\n');
  if (text.length <= MAX_RESULT_CHARS) return text;
  const note = '\n[... result truncated to fit the caller\'s context; full detail is in the artifacts ...]';
  return text.slice(0, MAX_RESULT_CHARS - note.length) + note;
}
