/**
 * Unit tests for the diagnostics (A17): what each answer means when the machine has, or lacks, Git Bash, Git, Python, the skills
 * and the endpoint. The machine is faked, so the answers do not depend on the one running the test.
 * Run from desktop/: `npm run test:diagnostics`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { countSkills, formatReport, runDiagnostics, type DiagnosticsDeps, type Run } from '../src/main/diagnostics';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-diag-'));
const skills = path.join(tmp, 'skills');
for (const s of ['a', 'b', 'c']) {
  fs.mkdirSync(path.join(skills, s), { recursive: true });
  fs.writeFileSync(path.join(skills, s, 'SKILL.md'), '---\nname: x\n---\n');
}
fs.mkdirSync(path.join(skills, 'no-skill-file'));
fs.writeFileSync(path.join(skills, 'loose.txt'), 'x');

/** A machine: which commands exist, and what they print. */
const machine = (has: Record<string, string>, docx = true): Run => async (command, args) => {
  if (args.includes('-c')) return { ok: docx && command in has, stdout: '' };
  return command in has ? { ok: true, stdout: has[command] } : { ok: false, stdout: '' };
};
const deps = (over: Partial<DiagnosticsDeps> = {}): DiagnosticsDeps => ({
  platform: 'win32',
  run: machine({ git: 'git version 2.45.1.windows.1', py: 'Python 3.12.4' }),
  shell: async () => ({ shell: 'C:\\Program Files\\Git\\bin\\bash.exe', posix: true }),
  bundledSkillsDir: skills,
  endpoint: async () => ({ configured: true, ok: true, models: 3 }),
  ...over,
});
const by = async (d: DiagnosticsDeps) => Object.fromEntries((await runDiagnostics(d)).map((i) => [i.id, i]));

console.log('\n=== a machine that has everything ===');
{
  const r = await by(deps());
  check('Git Bash, Git, Python, python-docx, the skills and the endpoint are all ok, with their values', r.bash.status === 'ok' && r.bash.value!.endsWith('bash.exe') && r.git.status === 'ok' && r.git.value === 'git version 2.45.1.windows.1' && r.python.status === 'ok' && r.python.value === 'Python 3.12.4' && r['python-docx'].status === 'ok' && r.skills.value === '3' && r.endpoint.status === 'ok' && r.endpoint.value === '3');
  check('only Python and python-docx are marked optional', Object.values(r).filter((i) => i.optional).map((i) => i.id).join() === 'python,python-docx');
  check('the skills are counted by folder with a SKILL.md, not by anything else in the directory', countSkills(skills) === 3 && countSkills(path.join(tmp, 'nowhere')) === 0);
}

console.log('\n=== what is missing ===');
{
  const noShell = await by(deps({ shell: async () => ({ shell: 'powershell.exe', posix: false }) }));
  check('on Windows, a shell that is not POSIX is missing (the agent would fall back to PowerShell), and says which one it uses', noShell.bash.status === 'missing' && noShell.bash.value === 'powershell.exe' && !noShell.bash.optional);
  check('the shell that could not be asked about is missing too, and not an error', (await by(deps({ shell: async () => { throw new Error('engine down'); } }))).bash.status === 'missing');
  check('elsewhere a non-POSIX shell is only a warning', (await by(deps({ platform: 'linux', shell: async () => ({ shell: 'fish', posix: false }) }))).bash.status === 'warn');

  const noGit = await by(deps({ run: machine({ py: 'Python 3.12.4' }) }));
  check('without git: missing, not optional', noGit.git.status === 'missing' && !noGit.git.optional);

  const noPython = await by(deps({ run: machine({ git: 'git version 2' }) }));
  check('without Python: missing, optional, and python-docx cannot be there either', noPython.python.status === 'missing' && noPython.python.optional && noPython['python-docx'].status === 'missing');
  const store = await by(deps({ run: async (c, a) => (c === 'python' ? { ok: true, stdout: 'Python was not found; run without arguments to install from the Microsoft Store' } : machine({ git: 'g' })(c, a)) }));
  check('the Microsoft Store stub is not a Python (it prints a hint, not a version)', store.python.status === 'missing');
  const py2 = await by(deps({ run: machine({ git: 'g', python: 'Python 2.7.18' }) }));
  check('Python 2 is not Python 3', py2.python.status === 'missing');
  const viaPython = await by(deps({ run: machine({ git: 'g', python: 'Python 3.11.9' }) }));
  check('when there is no launcher, python itself is found', viaPython.python.status === 'ok' && viaPython.python.value === 'Python 3.11.9');
  const noDocx = await by(deps({ run: machine({ git: 'g', py: 'Python 3.12.4' }, false) }));
  check('Python without python-docx: Python ok, python-docx missing (optional)', noDocx.python.status === 'ok' && noDocx['python-docx'].status === 'missing' && noDocx['python-docx'].optional);

  const noSkills = await by(deps({ bundledSkillsDir: path.join(tmp, 'empty') }));
  check('no skills next to the app is missing (an incomplete install)', noSkills.skills.status === 'missing' && noSkills.skills.value === '0');
}

console.log('\n=== the endpoint ===');
{
  check('not configured yet: missing, with nothing to show', (await by(deps({ endpoint: async () => ({ configured: false }) }))).endpoint.status === 'missing' && (await by(deps({ endpoint: async () => ({ configured: false }) }))).endpoint.value === undefined);
  const bad = await by(deps({ endpoint: async () => ({ configured: true, ok: false, message: 'The key was not accepted (401)' }) }));
  check('an endpoint that does not answer is missing, with the reason', bad.endpoint.status === 'missing' && bad.endpoint.value === 'The key was not accepted (401)');
  check('a reason is kept short', (await by(deps({ endpoint: async () => ({ configured: true, ok: false, message: 'x'.repeat(1000) }) }))).endpoint.value!.length === 200);
  check('a test that throws is reported as not answering, never as a crash', (await by(deps({ endpoint: async () => { throw new Error('boom'); } }))).endpoint.value === 'boom');
}

console.log('\n=== the report to paste ===');
{
  const items = await runDiagnostics(deps({ run: machine({ git: 'git version 2' }), endpoint: async () => ({ configured: true, ok: false, message: 'timeout' }) }));
  const text = formatReport(items, { app: 'alia Harness', version: '1.0.0', platform: 'win32' });
  check('it has the app and the machine, then one line per item, with optional ones marked', text.startsWith('app: alia Harness\nversion: 1.0.0\nplatform: win32\n') && text.includes('bash: ok — C:\\Program Files\\Git\\bin\\bash.exe') && text.includes('python: missing (optional)') && text.includes('endpoint: missing — timeout'), text);
  check('it has no key, no address and no project path', !/sk-|https?:\/\/|projeto/i.test(text));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll diagnostics checks passed.');
