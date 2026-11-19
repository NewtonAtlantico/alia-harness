/**
 * Unit tests for the renderer's pure logic (greeting, times, session marks, pipeline chip, names). No browser.
 * Run from desktop/: `npm run test:ui-logic`.
 */
import { chipFor } from '../src/renderer/src/lib/pipelineChip';
import { greetingFor } from '../src/renderer/src/lib/greeting';
import { projectName } from '../src/renderer/src/lib/projectName';
import { relativeTime } from '../src/renderer/src/lib/relativeTime';
import { fromActive, reduceSessionStates, stateOf, withWaiting, type SessionStates } from '../src/renderer/src/lib/sessionStates';
import type { PushMessage } from '../src/shared/ipc';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const at = (h: number, m = 0) => new Date(2026, 10, 19, h, m, 0);

console.log('\n=== the greeting follows the hour ===');
{
  check('morning from 5:00 to 11:59', greetingFor(at(5), 'Newton') === 'Bom dia, Newton' && greetingFor(at(11, 59), 'Newton') === 'Bom dia, Newton');
  check('afternoon from 12:00 to 17:59', greetingFor(at(12), 'Newton') === 'Boa tarde, Newton' && greetingFor(at(17, 59), 'Newton') === 'Boa tarde, Newton');
  check('evening from 18:00, and through the night until 4:59', greetingFor(at(18), 'N') === 'Boa noite, N' && greetingFor(at(23, 59), 'N') === 'Boa noite, N' && greetingFor(at(0), 'N') === 'Boa noite, N' && greetingFor(at(4, 59), 'N') === 'Boa noite, N');
  check('without a name there is no dangling comma, and spaces around a name are dropped', greetingFor(at(9), '') === 'Bom dia' && greetingFor(at(9), '   ') === 'Bom dia' && greetingFor(at(9), '  Maria ') === 'Bom dia, Maria');
}

console.log('\n=== how long ago ===');
{
  const now = new Date(2026, 10, 19, 14, 0, 0);
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString();
  const min = 60_000;
  check('under a minute, and a clock slightly ahead: "agora"', relativeTime(ago(20_000), now) === 'agora' && relativeTime(ago(-5 * min), now) === 'agora');
  check('minutes up to 59', relativeTime(ago(5 * min), now) === 'há 5 min' && relativeTime(ago(59 * min), now) === 'há 59 min');
  check('hours the same day', relativeTime(ago(61 * min), now) === 'há 1 h' && relativeTime(new Date(2026, 10, 19, 8, 30).toISOString(), now) === 'há 5 h');
  check('"ontem" is the calendar day before, even when it was only a few hours ago', relativeTime(new Date(2026, 10, 18, 23, 30).toISOString(), new Date(2026, 10, 19, 6, 0)) === 'ontem' && relativeTime(new Date(2026, 10, 18, 9, 0).toISOString(), now) === 'ontem');
  check('days up to six, then the date', relativeTime(new Date(2026, 10, 16, 12).toISOString(), now) === 'há 3 dias' && relativeTime(new Date(2026, 10, 13, 12).toISOString(), now) === 'há 6 dias' && relativeTime(new Date(2026, 10, 12, 12).toISOString(), now) === '12/11/2026' && relativeTime(new Date(2025, 0, 5, 12).toISOString(), now) === '05/01/2025');
  check('a value that is not a date gives nothing', relativeTime('garbage', now) === '');
}

console.log('\n=== running and waiting marks ===');
{
  const msg = (m: PushMessage) => m;
  const started = (id: string, extra: object = {}): PushMessage => msg({ kind: 'event', sessionId: id, event: { type: 'run_started', runId: 'r', ...extra } as any });
  const finished = (id: string, extra: object = {}): PushMessage => msg({ kind: 'event', sessionId: id, event: { type: 'run_finished', runId: 'r', result: { status: 'completed', text: '', steps: 1 }, ...extra } as any });
  const ask = (id: string): PushMessage => msg({ kind: 'interaction', interaction: { id: `i-${Math.random()}`, sessionId: id, kind: 'permission', command: 'x', reasons: [], dangerous: false, canAlwaysAllow: true } });
  const closed = (id: string): PushMessage => msg({ kind: 'interaction_closed', id: 'i', sessionId: id });

  let s: SessionStates = {};
  check('nothing is known: idle', stateOf(s, 'a').running === false && stateOf(s, 'a').waiting === 0);
  s = reduceSessionStates(s, started('a'));
  check('a run starting marks it running', stateOf(s, 'a').running && !stateOf(s, 'b').running);
  const afterAsk = reduceSessionStates(reduceSessionStates(s, ask('a')), closed('a'));
  check('approvals and questions are not counted here (the pending list is the one source for that), so nothing changes', afterAsk === s || JSON.stringify(afterAsk) === JSON.stringify(s));
  s = reduceSessionStates(s, finished('a'));
  check('the end of the run clears it', !stateOf(s, 'a').running && stateOf(s, 'a').waiting === 0);
  s = reduceSessionStates(s, started('a'));
  s = reduceSessionStates(s, started('b', { subagentId: 'child' }));
  s = reduceSessionStates(s, finished('a', { subagentId: 'child' }));
  check('events from a subagent neither start nor end a conversation\'s run', stateOf(s, 'a').running && !stateOf(s, 'b').running);
  check('other messages change nothing (the very same object comes back)', reduceSessionStates(s, { kind: 'window_state', maximized: true }) === s && reduceSessionStates(s, { kind: 'command', command: 'new_conversation' }) === s);
  check('the engine going down forgets every conversation; coming back changes nothing', Object.keys(reduceSessionStates(s, { kind: 'engine_status', status: 'down' })).length === 0 && reduceSessionStates(s, { kind: 'engine_status', status: 'restarted' }) === s);
  const snap = fromActive([{ sessionId: 'x', workspace: 'w', running: true, waiting: 2 }, { sessionId: 'y', workspace: 'w', running: false, waiting: 0 }]);
  check('the engine\'s own list is the starting point after a reload', stateOf(snap, 'x').running && stateOf(snap, 'x').waiting === 2 && !stateOf(snap, 'y').running);
}

console.log('\n=== what is waiting comes from the pending list ===');
{
  const base = { a: { running: true, waiting: 5 }, b: { running: false, waiting: 0 } } as const;
  const shown = withWaiting(base, [{ sessionId: 'a' }, { sessionId: 'c' }, { sessionId: 'c' }]);
  check('the count is the number of pending items, whatever the pushes said before', shown.a.waiting === 1 && shown.c.waiting === 2 && shown.b.waiting === 0);
  check('a conversation with something waiting is running, even if no run event was seen (a page opened mid-run)', shown.c.running === true && shown.b.running === false && shown.a.running === true);
  check('answering the last one clears the mark at once', withWaiting(base, []).a.waiting === 0 && withWaiting(base, []).a.running === true);
  check('nothing pending, nothing known: nothing', Object.keys(withWaiting({}, [])).length === 0);
}

console.log('\n=== the pipeline chip ===');
{
  const base = { exists: true, summary: 's' } as const;
  check('waiting at a gate shows how many questions are answered', JSON.stringify(chipFor({ ...base, state: 'answer_questions', gate: 'G1', answered: 3, total: 5 })) === JSON.stringify({ label: 'G1 · 3/5', tone: 'waiting' }));
  check('a gate to approve, and specs to review', chipFor({ ...base, state: 'pass_gate', gate: 'G2' })?.label === 'G2 · aprovar' && chipFor({ ...base, state: 'review_specs', gate: 'G3' })?.label === 'G3 · revisão');
  check('a stage running, done, and the two problems', chipFor({ ...base, state: 'run_stage', stage: 2 })?.label === 'Etapa 2' && chipFor({ ...base, state: 'complete' })?.tone === 'done' && chipFor({ ...base, state: 'inputs_changed' })?.tone === 'warn' && chipFor({ ...base, state: 'damaged' })?.tone === 'warn');
  check('a project without a pipeline has no chip', chipFor({ exists: false, summary: '', state: 'not_started' }) === null && chipFor({ ...base, state: 'not_started' }) === null);
}

console.log('\n=== project names ===');
{
  check('Windows and POSIX paths', projectName('C:\\Projetos\\portal-cliente') === 'portal-cliente' && projectName('/home/ana/projetos/portal') === 'portal');
  check('trailing and doubled separators', projectName('C:\\Projetos\\portal-cliente\\') === 'portal-cliente' && projectName('/a//b/') === 'b');
  check('a drive root and an empty path do not crash', projectName('C:\\') === 'C:' && projectName('') === '');
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll UI logic checks passed.');
