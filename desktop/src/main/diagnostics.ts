/**
 * What the app needs from the machine, and whether it is there: Git Bash (the shell the agent runs commands in), Git,
 * Python (only one skill needs it, with python-docx), the skills that ship with the app, and the endpoint. Each answer is a
 * status and a value; the words and the instructions to fix it are the page's. The probes are injected so a test can say what
 * the machine has. No Electron in here.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export type DiagId = 'bash' | 'git' | 'python' | 'python-docx' | 'skills' | 'endpoint';
export type DiagStatus = 'ok' | 'warn' | 'missing';

export interface DiagItem {
  id: DiagId;
  status: DiagStatus;
  /** A path, a version, a count, or the reason (for the endpoint, the message). Never a secret. */
  value?: string;
  /** Whether the app works without it (Python, python-docx): a `missing` one is then shown as a warning. */
  optional: boolean;
}

export interface ProbeOutcome {
  ok: boolean;
  stdout: string;
}
export type Run = (command: string, args: string[]) => Promise<ProbeOutcome>;

export interface DiagnosticsDeps {
  platform: NodeJS.Platform;
  run: Run;
  /** What core would use to run a command (from the engine), or an error when it could not say. */
  shell: () => Promise<{ shell: string; posix: boolean } | undefined>;
  bundledSkillsDir: string;
  /** The endpoint test the settings screen already has (no key is ever returned). */
  endpoint: () => Promise<{ configured: boolean; ok?: boolean; message?: string; models?: number }>;
}

/** The real runner: runs a program with a short timeout and never throws. */
export const execRun: Run = (command, args) =>
  new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 8000, windowsHide: true, encoding: 'utf8' }, (error, stdout, stderr) => resolve({ ok: !error, stdout: `${stdout ?? ''}${stderr ?? ''}`.trim() }));
    } catch {
      resolve({ ok: false, stdout: '' });
    }
  });

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

/** How many folders in the skills directory have a SKILL.md. */
export function countSkills(dir: string): number {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'SKILL.md'))).length;
  } catch {
    return 0;
  }
}

export async function runDiagnostics(deps: DiagnosticsDeps): Promise<DiagItem[]> {
  const items: DiagItem[] = [];

  // The shell the agent runs commands in. On Windows anything but a real POSIX shell makes "&&" and pipes fail.
  const shell = await deps.shell().catch(() => undefined);
  if (shell?.posix) items.push({ id: 'bash', status: 'ok', value: shell.shell, optional: false });
  else items.push({ id: 'bash', status: deps.platform === 'win32' ? 'missing' : 'warn', ...(shell ? { value: shell.shell } : {}), optional: false });

  const git = await deps.run('git', ['--version']);
  items.push(git.ok ? { id: 'git', status: 'ok', value: firstLine(git.stdout), optional: false } : { id: 'git', status: 'missing', optional: false });

  // Python: the Windows launcher first, then python itself. The Microsoft Store stub prints a hint and fails: not a Python.
  let python: { command: string; version: string } | undefined;
  for (const [command, args] of [['py', ['-3', '--version']], ['python', ['--version']], ['python3', ['--version']]] as Array<[string, string[]]>) {
    const r = await deps.run(command, args);
    if (r.ok && /Python\s+3\./i.test(r.stdout)) {
      python = { command, version: firstLine(r.stdout) };
      break;
    }
  }
  items.push(python ? { id: 'python', status: 'ok', value: python.version, optional: true } : { id: 'python', status: 'missing', optional: true });
  if (python) {
    const args = python.command === 'py' ? ['-3', '-I', '-c', 'import docx'] : ['-I', '-c', 'import docx'];
    const docx = await deps.run(python.command, args);
    items.push({ id: 'python-docx', status: docx.ok ? 'ok' : 'missing', optional: true });
  } else {
    items.push({ id: 'python-docx', status: 'missing', optional: true });
  }

  const skills = countSkills(deps.bundledSkillsDir);
  items.push({ id: 'skills', status: skills > 0 ? 'ok' : 'missing', value: String(skills), optional: false });

  const endpoint: Awaited<ReturnType<DiagnosticsDeps['endpoint']>> = await deps.endpoint().catch((e: Error) => ({ configured: true, ok: false, message: e.message }));
  if (!endpoint.configured) items.push({ id: 'endpoint', status: 'missing', optional: false });
  else if (endpoint.ok) items.push({ id: 'endpoint', status: 'ok', value: String(endpoint.models ?? 0), optional: false });
  else items.push({ id: 'endpoint', status: 'missing', value: (endpoint.message ?? '').slice(0, 200), optional: false });
  return items;
}

/** The report to paste in a support message: one line per item, then the app and the machine. No secrets, no conversation content. */
export function formatReport(items: DiagItem[], app: Record<string, string>): string {
  return [
    ...Object.entries(app).map(([k, v]) => `${k}: ${v}`),
    '',
    ...items.map((i) => `${i.id}: ${i.status === 'missing' && i.optional ? 'missing (optional)' : i.status}${i.value ? ` — ${i.value}` : ''}`),
  ].join('\n');
}
