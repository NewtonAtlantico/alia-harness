import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PipelineStateStore } from '../src/core/pipeline/pipelineState.js';
import { buildReport, computeChecks } from '../src/core/pipeline/report.js';
import { summarizeTasks } from '../src/core/pipeline/taskStats.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const FIXTURES = path.resolve('scripts', 'fixtures', 'pipeline');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-report-'));
let n = 0;
const mk = () => {
  const dir = path.join(tmp, `ws-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const NOW = new Date('2026-11-19T12:00:00.000Z');
const withFixture = () => {
  const ws = mk();
  fs.cpSync(path.join(FIXTURES, 'docs'), path.join(ws, 'docs'), { recursive: true });
  return ws;
};
const store = (ws: string) => new PipelineStateStore(ws, { now: () => NOW });
const apply = (ws: string, ops: unknown[]) => {
  const r = store(ws).apply(ops);
  if (!r.ok) throw new Error(`setup failed: ${r.error}`);
  return r.state;
};
const spec = (slug: string, dependsOn: string[] = []) => ({ op: 'set_spec', slug, title: `Spec ${slug}`, depends_on: dependsOn });
const doneStages = [1, 2, 3, 4].flatMap((s) => [{ op: 'set_stage', stage: s, status: 'running' }, { op: 'set_stage', stage: s, status: 'done' }, ...(s < 4 ? [{ op: 'set_gate', gate: `G${s}`, status: 'passed' }] : [])]);

console.log('\n=== set_check ===');
{
  const ws = mk();
  const bad = (op: object) => { const r = store(ws).apply([op]); return r.ok ? '' : r.error; };
  check('a check needs a key without spaces', bad({ op: 'set_check', status: 'pass' }).includes('"key" is required') && bad({ op: 'set_check', key: 'a b', status: 'pass' }).includes('"key" is required'));
  check('its status is pass or fail', bad({ op: 'set_check', key: 'coverage', status: 'maybe' }).includes('pass or fail'));
  check('a failure says what is wrong, or it is refused', bad({ op: 'set_check', key: 'coverage', status: 'fail' }).includes('needs a "detail"'));
  check('nothing was written by the refusals', !store(ws).exists());
  const s1 = apply(ws, [{ op: 'set_check', key: 'coverage', status: 'fail', detail: 'RF-12 has no task' }]);
  check('a check is recorded with its date', s1.checks.length === 1 && s1.checks[0].status === 'fail' && s1.checks[0].detail === 'RF-12 has no task' && s1.checks[0].date === '2026-11-19');
  const s2 = apply(ws, [{ op: 'set_check', key: 'coverage', status: 'pass' }]);
  check('recording it again replaces it (one per key), and the detail goes', s2.checks.length === 1 && s2.checks[0].status === 'pass' && s2.checks[0].detail === undefined);
  apply(ws, [{ op: 'set_check', key: 'naming', status: 'pass' }]);
  const md = fs.readFileSync(path.join(ws, 'docs', 'pipeline', 'STATE.md'), 'utf8');
  check('STATE.md lists them', md.includes('## Cross-spec checks') && md.includes('| coverage | pass |') && md.includes('| naming | pass |'));
  const none = mk();
  apply(none, [{ op: 'add_input', name: 'a.txt' }]);
  check('a state without checks renders no such section (the old layout is untouched)', !fs.readFileSync(path.join(none, 'docs', 'pipeline', 'STATE.md'), 'utf8').includes('Cross-spec'));
  const old = path.join(mk(), 'state.json');
  check('a state.json written before checks existed loads, with none', (() => { const dir = mk(); fs.mkdirSync(path.join(dir, 'docs', 'pipeline'), { recursive: true }); fs.writeFileSync(path.join(dir, 'docs', 'pipeline', 'state.json'), JSON.stringify({ version: 1, updatedAt: NOW.toISOString() })); void old; return store(dir).load()!.checks.length === 0; })());
}

console.log('\n=== computed checks on the golden backlog ===');
{
  const ws = withFixture();
  const stats = summarizeTasks(ws);
  const specs = (deps: Record<string, string[]>) => Object.entries(deps).map(([slug, dependsOn]) => ({ slug, title: slug, dependsOn, constraints: [] }));
  const full = specs({ '01-login-sso': [], '02-consultar-pedidos': ['01-login-sso'], '03-abrir-chamado': ['01-login-sso'], '04-acesso-parceiros': ['01-login-sso', '02-consultar-pedidos'] });
  const get = (checks: ReturnType<typeof computeChecks>, key: string) => checks.find((c) => c.key === key)!;

  const ok = computeChecks(stats, full);
  check('points, cycles and story dependencies pass; coverage is unknown until the model records it', get(ok, 'points').state === 'pass' && get(ok, 'cycles').state === 'pass' && get(ok, 'story_dependencies').state === 'pass' && get(ok, 'coverage').state === 'unknown' && get(ok, 'coverage').source === 'recorded');
  check('computed ones say so, and list nothing when they pass', get(ok, 'points').source === 'computed' && ok.every((c) => c.items.length === 0));

  const missing = computeChecks(stats, specs({ '01-login-sso': [], '02-consultar-pedidos': [], '03-abrir-chamado': ['01-login-sso'], '04-acesso-parceiros': ['01-login-sso'] }));
  check('a task that waits for another story, in a story that does not depend on it, fails the dependency check and names the task', get(missing, 'story_dependencies').state === 'fail' && get(missing, 'story_dependencies').items.some((i) => i.includes('02-consultar-pedidos') && i.includes('T2.1') && i.endsWith('-> 01-login-sso')) && get(missing, 'story_dependencies').items.some((i) => i.includes('04-acesso-parceiros') && i.endsWith('-> 02-consultar-pedidos')), JSON.stringify(get(missing, 'story_dependencies').items));
  check('without spec summaries a cross-story dependency cannot be judged: unknown, not a false pass', get(computeChecks(stats, []), 'story_dependencies').state === 'unknown');
  check('with no tasks nothing is judged', computeChecks(summarizeTasks(mk()), full).filter((c) => c.source === 'computed').every((c) => c.state === 'unknown'));

  const bad = withFixture();
  fs.writeFileSync(path.join(bad, 'docs', 'tasks', '05-extra-tasks.md'), '# Tasks: extra\n\n### 5.1 Grande demais\n**Slice:** x\n**Story points:** 13\n**Depends on:** 5.2\n\n### 5.2 Sem pontos\n**Slice:** x\n**Depends on:** 5.1\n\n### 5.3 Perdida\n**Slice:** x\n**Story points:** 3\n**Depends on:** 9.9\n');
  const broken = computeChecks(summarizeTasks(bad), full);
  check('a task over 8 points or without points fails the points check, by task', get(broken, 'points').state === 'fail' && get(broken, 'points').items.length === 2 && get(broken, 'points').items.some((i) => i.includes('Grande demais') && i.includes('13 points')) && get(broken, 'points').items.some((i) => i.includes('Sem pontos') && i.includes('no points')));
  check('a cycle fails the cycle check, with the way round', get(broken, 'cycles').state === 'fail' && get(broken, 'cycles').items[0].includes('5.1') && get(broken, 'cycles').items[0].includes('5.2'), JSON.stringify(get(broken, 'cycles').items));
  check('a reference to nothing fails the dependency check', get(broken, 'story_dependencies').state === 'fail' && get(broken, 'story_dependencies').items.some((i) => i.includes('Perdida') && i.endsWith('-> 9.9')));

  const recordedFail = computeChecks(stats, full, [{ key: 'coverage', status: 'fail', detail: 'RF-12 has no task' }, { key: 'naming', status: 'pass' }]);
  check('a check the model recorded keeps its words, and any other key is listed after the known ones', get(recordedFail, 'coverage').state === 'fail' && get(recordedFail, 'coverage').detail === 'RF-12 has no task' && recordedFail.at(-1)!.key === 'naming' && recordedFail.at(-1)!.state === 'pass');
}

console.log('\n=== the final report ===');
{
  const ws = withFixture();
  apply(ws, [
    { op: 'add_input', name: 'brd.pdf', input_kind: 'document' },
    ...doneStages,
    spec('01-login-sso'), spec('02-consultar-pedidos', ['01-login-sso']), spec('03-abrir-chamado', ['01-login-sso']), spec('04-acesso-parceiros', ['01-login-sso', '02-consultar-pedidos']),
    ...['01-login-sso', '02-consultar-pedidos', '03-abrir-chamado', '04-acesso-parceiros'].map((s) => ({ op: 'set_spec_review', spec: s, status: 'reviewed', by: 'Ana' })),
    { op: 'add_adr', id: 'ADR-001', title: 'PostgreSQL', status: 'accepted' }, { op: 'add_adr', id: 'ADR-002', title: 'Fila', status: 'accepted' }, { op: 'add_adr', id: 'ADR-003', title: 'SSO', status: 'accepted' },
    { op: 'set_check', key: 'coverage', status: 'pass' },
  ]);
  const state = store(ws).load()!;
  const stats = summarizeTasks(ws);
  const report = buildReport(state, stats);
  check('the totals are those of the design: 4 specs, 11 tasks, 45 points, 3 ADRs', report.specs === 4 && report.tasks === 11 && report.points === 45 && report.adrs === 3);
  check('the backlog is by spec, with the title from the summary, the tasks and the points', report.backlog.length === 4 && report.backlog[0].title === 'Spec 01-login-sso' && report.backlog[0].tasks.length === 3 && report.backlog[0].points === 11 && report.backlog[3].dependsOn.join() === '01-login-sso,02-consultar-pedidos');
  check('every check passes, and nothing blocks', report.checks.every((c) => c.state === 'pass') && report.checks.length === 4 && report.blockers.length === 0, JSON.stringify(report.blockers));

  apply(ws, [{ op: 'add_question', gate: 'G2', id: 'late', prompt: 'Nova dúvida?' }, { op: 'set_spec_review', spec: '03-abrir-chamado', status: 'in_review' }, { op: 'set_check', key: 'coverage', status: 'fail', detail: 'RF-12 has no task' }]);
  const blocked = buildReport(store(ws).load()!, stats, [{ name: 'brd.pdf', path: 'brd.pdf', reason: 'changed' }]);
  const kinds = blocked.blockers.map((b) => `${b.kind}:${b.ref}`);
  check('what blocks is listed by what it is: an open question, an unreviewed spec, a failed check, a changed input', kinds.includes('question:late') && kinds.includes('spec_review:03-abrir-chamado') && kinds.includes('check:coverage') && kinds.includes('input_changed:brd.pdf'), kinds.join());
  check('a stage that is not done blocks too', (() => { const w2 = mk(); apply(w2, [{ op: 'add_input', name: 'a.txt' }]); return buildReport(store(w2).load()!, summarizeTasks(w2)).blockers.filter((b) => b.kind === 'stage').length === 4; })());
  check('a problem in the task files blocks, in its own words', (() => { const w3 = withFixture(); fs.appendFileSync(path.join(w3, 'docs', 'tasks', '01-login-sso-tasks.md'), '\n### 1.9 Sem pontos\n**Slice:** x\n'); apply(w3, [{ op: 'add_input', name: 'a.txt' }]); return buildReport(store(w3).load()!, summarizeTasks(w3)).blockers.some((b) => b.kind === 'task_problem' && b.ref.includes('no story points')); })());
}

fs.rmSync(tmp, { recursive: true, force: true });
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll pipeline report checks passed.');
