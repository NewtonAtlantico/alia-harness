/**
 * Runs everything the desktop app is held to, in order, and prints one table: typecheck, the unit suites, one build, the
 * end-to-end suites in the real app, the smoke test, and (with `--package`) the packaged app. Stops at the end, not at the first
 * failure, so one run shows all that is broken. `--core` adds core's own suites; `--only <text>` runs the suites whose name has it.
 * Run from desktop/: `npm run test:all`. Exit code 1 when anything failed.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(desktop, '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;
const withPackage = args.includes('--package');
const withCore = args.includes('--core');

interface Suite {
  name: string;
  command: string[];
  cwd: string;
  group: 'static' | 'unit' | 'build' | 'e2e' | 'smoke' | 'package' | 'core';
}

const tsx = (script: string): string[] => ['npx', 'tsx', '--tsconfig', 'tsconfig.node.json', `scripts/${script}.ts`];
const unit = ['engine', 'security', 'settings', 'projects', 'ui-logic', 'timeline', 'composer-logic', 'interactions-logic', 'panel-logic', 'intake-logic', 'run-logic', 'diagnostics'];
const e2e = ['app', 'hardening', 'settings-app', 'sidebar-app', 'timeline-app', 'composer-app', 'interactions-app', 'panel-app', 'intake-app', 'run-app', 'gates-app', 'report-app', 'diagnostics-app', 'journey-app'];
const coreSuites = ['mentions', 'skills', 'agent', 'subagents', 'session', 'events', 'cancel', 'permissions', 'store', 'commands', 'changes', 'documents', 'office', 'askuser', 'pipeline', 'resume', 'intake', 'report', 'issues'];

const suites: Suite[] = [
  { name: 'typecheck', command: ['npm', 'run', 'typecheck'], cwd: desktop, group: 'static' },
  ...unit.map((n): Suite => ({ name: `test-${n}`, command: tsx(`test-${n}`), cwd: desktop, group: 'unit' })),
  { name: 'build', command: ['npm', 'run', 'build'], cwd: desktop, group: 'build' },
  ...e2e.map((n): Suite => ({ name: `test-${n}`, command: tsx(`test-${n}`), cwd: desktop, group: 'e2e' })),
  { name: 'smoke-app', command: ['npx', 'tsx', 'scripts/smoke-app.ts'], cwd: desktop, group: 'smoke' },
  ...(withPackage ? [{ name: 'test-package', command: tsx('test-package'), cwd: desktop, group: 'package' } as Suite, { name: 'test-installer', command: tsx('test-installer'), cwd: desktop, group: 'package' } as Suite] : []),
  ...(withCore ? [{ name: 'core typecheck', command: ['npx', 'tsc', '--noEmit'], cwd: root, group: 'core' } as Suite, ...coreSuites.map((n): Suite => ({ name: `core test:${n}`, command: ['npm', 'run', `test:${n}`], cwd: root, group: 'core' }))] : []),
];

const selected = suites.filter((s) => !only || s.name.includes(only) || s.group === 'build');
const results: Array<{ name: string; ok: boolean; seconds: number }> = [];
const win = process.platform === 'win32';

for (const suite of selected) {
  const started = Date.now();
  process.stdout.write(`▶ ${suite.name} … `);
  const [cmd, ...rest] = suite.command;
  const run = spawnSync(win && (cmd === 'npm' || cmd === 'npx') ? `${cmd}.cmd` : cmd, rest, { cwd: suite.cwd, encoding: 'utf8', shell: win, env: { ...process.env, FORCE_COLOR: '0' }, maxBuffer: 64 * 1024 * 1024 });
  const ok = run.status === 0;
  const seconds = Math.round((Date.now() - started) / 100) / 10;
  results.push({ name: suite.name, ok, seconds });
  console.log(`${ok ? 'ok' : 'FAILED'} (${seconds}s)`);
  if (!ok) {
    const out = `${run.stdout ?? ''}${run.stderr ?? ''}`.split('\n').filter((l) => /✘|failed|Error|error/i.test(l)).slice(0, 12);
    for (const l of out) console.log(`    ${l.trim()}`);
  }
}

const failed = results.filter((r) => !r.ok);
const total = Math.round(results.reduce((n, r) => n + r.seconds, 0));
console.log(`\n${results.length - failed.length} of ${results.length} suites passed in ${total}s.`);
if (failed.length > 0) {
  console.log(`Failed: ${failed.map((f) => f.name).join(', ')}`);
  process.exit(1);
}
