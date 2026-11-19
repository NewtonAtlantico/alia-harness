/**
 * Unit tests for project trust and the broker rules around it (A5). Run from desktop/: `npm run test:projects`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Broker, ProjectRegistry } from '../src/main/broker';
import { TrustStore, inspectProject, listProjectSkills } from '../src/main/trust';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-projects-'));
let n = 0;
const mk = (label = 'd') => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const skill = (project: string, name: string, withFile = true) => {
  const dir = path.join(project, '.alia', 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  if (withFile) fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: test\n---\nbody\n`);
};

console.log('\n=== trusting a folder ===');
{
  const dir = mk();
  const file = path.join(dir, 'trust.json');
  const project = mk('proj');
  const t = new TrustStore(file, () => new Date('2026-11-19T10:00:00Z'));
  check('a folder never asked about is "unknown", and nothing is trusted by default', t.get(project) === 'unknown' && !t.isTrusted(project) && !fs.existsSync(file));
  t.set(project, true);
  check('trusting it is remembered, with the time', t.get(project) === 'trusted' && t.isTrusted(project) && fs.readFileSync(file, 'utf8').includes('2026-11-19T10:00:00.000Z'));
  check('...and survives a new instance (a restart)', new TrustStore(file).get(project) === 'trusted');
  t.set(project, false);
  check('declining is remembered too, and is not trust', t.get(project) === 'declined' && !t.isTrusted(project));
  t.set(project, true);
  check('the answer can be changed later', t.isTrusted(project));
  const other = mk('proj');
  check('trust is per folder, not for its neighbours, parent or children', !t.isTrusted(other) && !t.isTrusted(path.dirname(project)) && !t.isTrusted(path.join(project, 'sub')));
  check('the same folder written another way is the same folder', t.isTrusted(path.join(project, 'x', '..')) && t.isTrusted(project + path.sep) && (process.platform !== 'win32' || t.isTrusted(project.toUpperCase())));
  check('no temporary file is left behind', fs.readdirSync(dir).join() === 'trust.json');
  fs.writeFileSync(file, '{ broken');
  check('a damaged file trusts nothing', new TrustStore(file).get(project) === 'unknown');
  fs.writeFileSync(file, JSON.stringify({ version: 1, folders: { [project.toLowerCase()]: { trusted: 'yes' }, x: 5 } }));
  check('entries of the wrong shape do not count as trust', !new TrustStore(file).isTrusted(project));
  check('the trust file is in the data folder, never in the project', !fs.existsSync(path.join(project, '.alia')));
}

console.log('\n=== skills a project carries ===');
{
  const project = mk('proj');
  check('none when there is no .alia folder', listProjectSkills(project).length === 0);
  skill(project, 'beta');
  skill(project, 'alpha');
  skill(project, 'broken', false);
  fs.writeFileSync(path.join(project, '.alia', 'skills', 'a-file.md'), 'x');
  check('skill folders with a SKILL.md, by name; folders without one and loose files are not skills', listProjectSkills(project).join() === 'alpha,beta');
  const trust = new TrustStore(path.join(mk(), 'trust.json'));
  check('inspect reports trust and skills together', JSON.stringify(inspectProject(trust, project)) === JSON.stringify({ trust: 'unknown', projectSkills: ['alpha', 'beta'] }));
}

console.log('\n=== the broker, folders and trust ===');
{
  const calls: Array<{ name: string; payload: any }> = [];
  const mainCalls: string[] = [];
  const projects = new ProjectRegistry();
  const trust = new TrustStore(path.join(mk(), 'trust.json'));
  const broker = new Broker({
    engine: { request: async (name: any, payload: any) => (calls.push({ name, payload }), {}) } as any,
    projects,
    pickFolder: async () => null,
    enrich: (name, request) => (name === 'session.open' ? { ...(request as object), trustedProject: trust.isTrusted((request as { projectPath: string }).projectPath) } : request),
    main: {
      'projects.inspect': ({ projectPath }) => (mainCalls.push('inspect'), inspectProject(trust, projectPath)),
      'projects.setTrust': ({ projectPath, trusted }) => (mainCalls.push('setTrust'), trust.set(projectPath, trusted), inspectProject(trust, projectPath)),
    },
  });
  const project = mk('proj');
  const refused = (name: string, payload: object) => broker.handle(name, payload).then(() => '', (e) => e.message);

  check('trust cannot be granted for a folder the user never opened (the main handler is not even called)', (await refused('projects.setTrust', { projectPath: project, trusted: true })).includes('folder dialog') && mainCalls.length === 0 && !trust.isTrusted(project));
  check('...nor can it be inspected', (await refused('projects.inspect', { projectPath: project })).includes('folder dialog') && mainCalls.length === 0);
  projects.allow(project);
  const after = (await broker.handle('projects.setTrust', { projectPath: project, trusted: true })) as any;
  check('once opened, the user\'s answer is recorded', after.trust === 'trusted' && trust.isTrusted(project) && mainCalls.join() === 'setTrust');
  check('the page cannot claim trust itself: session.open has no such field', (await refused('session.open', { projectPath: project, trustedProject: true })).includes('Unrecognized key') && calls.length === 0);
  await broker.handle('session.open', { projectPath: project });
  check('main adds the real answer when it forwards session.open', calls.length === 1 && calls[0].payload.trustedProject === true);
  trust.set(project, false);
  await broker.handle('session.open', { projectPath: project });
  check('...and it follows a later "no"', calls[1].payload.trustedProject === false);
  await broker.handle('conversations.list', {});
  check('other requests are forwarded untouched', !('trustedProject' in calls[2].payload));
  check('the answer must be a boolean', (await refused('projects.setTrust', { projectPath: project, trusted: 'yes' })).includes('trusted'));
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll project trust checks passed.');
