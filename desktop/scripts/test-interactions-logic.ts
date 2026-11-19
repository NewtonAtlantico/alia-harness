/**
 * Unit tests for what is waiting for the user (A8): the pending list, and turning a question form into answers.
 * No browser. Run from desktop/: `npm run test:interactions-logic`.
 */
import { OTHER, answerFor, answeredCount, buildAnswers, forSession, needsOwner, reducePending, type Pending } from '../src/renderer/src/lib/interactions';
import type { Interaction, PushMessage, UserQuestion } from '../src/shared/ipc';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const perm = (id: string, sessionId = 's1', toolCallId = `t-${id}`): Interaction => ({ id, sessionId, kind: 'permission', command: 'npm run build', reasons: [], dangerous: false, canAlwaysAllow: true, toolCallId });
const ask = (id: string, sessionId = 's1', questions: UserQuestion[] = []): Interaction => ({ id, sessionId, kind: 'ask_user', questions });
const push = (message: PushMessage) => ({ type: 'push' as const, message });
const ids = (l: Pending) => l.map((i) => i.id).join();

console.log('\n=== the pending list ===');
{
  let l: Pending = [];
  l = reducePending(l, push({ kind: 'interaction', interaction: perm('a') }));
  l = reducePending(l, push({ kind: 'interaction', interaction: ask('b') }));
  l = reducePending(l, push({ kind: 'interaction', interaction: perm('c', 's2') }));
  check('requests queue in the order they arrive', ids(l) === 'a,b,c');
  check('the same request arriving twice is one', ids(reducePending(l, push({ kind: 'interaction', interaction: perm('a') }))) === 'a,b,c');
  check('each conversation sees only its own', ids(forSession(l, 's1')) === 'a,b' && ids(forSession(l, 's2')) === 'c' && forSession(l, 'zz').length === 0);
  check('closing one (a cancelled run) removes just that one', ids(reducePending(l, push({ kind: 'interaction_closed', id: 'b', sessionId: 's1' }))) === 'a,c');
  check('answering removes it (the page does this itself as soon as it responds)', ids(reducePending(l, { type: 'remove', id: 'a' })) === 'b,c');
  const resolved: PushMessage = { kind: 'event', sessionId: 's1', event: { type: 'permission_resolved', id: 'core-id', toolCallId: 't-a', decision: 'allow_once' } };
  check('an approval decided elsewhere (the engine says so) takes its card away, and only that one', ids(reducePending(l, push(resolved))) === 'b,c');
  check('...but not a question, nor another conversation\'s approval with the same call id', ids(reducePending([perm('x', 's1', 'same'), perm('y', 's2', 'same')], push({ kind: 'event', sessionId: 's1', event: { type: 'permission_resolved', id: 'i', toolCallId: 'same', decision: 'deny' } }))) === 'y');
  check('a resolution with no tool call id changes nothing', reducePending(l, push({ kind: 'event', sessionId: 's1', event: { type: 'permission_resolved', id: 'i', decision: 'deny' } })) === l);
  check('the engine going down empties it; coming back does not', reducePending(l, push({ kind: 'engine_status', status: 'down' })).length === 0 && reducePending(l, push({ kind: 'engine_status', status: 'restarted' })) === l);
  check('a reset replaces everything (after asking the engine what is pending)', ids(reducePending(l, { type: 'reset', interactions: [perm('z')] })) === 'z');
  check('other messages change nothing, and give back the very same list', reducePending(l, push({ kind: 'window_state', maximized: true })) === l);
}

console.log('\n=== answers from a form ===');
{
  const choice: UserQuestion = { id: 'q1', kind: 'choice', prompt: 'Qual versão?', options: [{ id: 'v1', label: 'v1' }, { id: 'v2', label: 'v2' }], allowOther: true, allowDefer: true };
  const strict: UserQuestion = { id: 'q2', kind: 'choice', prompt: 'x', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
  const text: UserQuestion = { id: 'q3', kind: 'text', prompt: 'Quantos usuários?', allowDefer: true };
  const confirm: UserQuestion = { id: 'q4', kind: 'confirm', prompt: 'Entra no MVP?' };
  const all = [choice, strict, text, confirm];

  check('nothing filled in: no answers (the questions stay open)', buildAnswers(all, {}, 'Newton').length === 0 && answeredCount(all, {}, 'Newton') === 0);
  check('an option is its id', JSON.stringify(answerFor(choice, { choice: 'v2' }, 'N')) === JSON.stringify({ id: 'q1', answer: 'v2' }));
  check('an option that is not one of the options is not an answer', answerFor(choice, { choice: 'v9' }, 'N') === undefined && answerFor(strict, { choice: OTHER, other: 'c' }, 'N') === undefined);
  check('"other" is the text, trimmed, only when allowed and not empty', JSON.stringify(answerFor(choice, { choice: OTHER, other: '  v3 beta ' }, 'N')) === JSON.stringify({ id: 'q1', answer: 'v3 beta' }) && answerFor(choice, { choice: OTHER, other: '   ' }, 'N') === undefined);
  check('text is trimmed; blank is open', JSON.stringify(answerFor(text, { text: ' 500 ' }, 'N')) === JSON.stringify({ id: 'q3', answer: '500' }) && answerFor(text, { text: '  ' }, 'N') === undefined);
  check('a yes/no is a real boolean, and false counts as an answer', answerFor(confirm, { confirm: true }, 'N')?.answer === true && answerFor(confirm, { confirm: false }, 'N')?.answer === false && answerFor(confirm, {}, 'N') === undefined);
  check('deferring carries an owner: the one typed, or the user by default', JSON.stringify(answerFor(text, { deferred: true, owner: 'Maria' }, 'Newton')) === JSON.stringify({ id: 'q3', deferred: true, owner: 'Maria' }) && JSON.stringify(answerFor(text, { deferred: true }, 'Newton')) === JSON.stringify({ id: 'q3', deferred: true, owner: 'Newton' }));
  check('deferral wins over an answer typed earlier, and works for a choice too', answerFor(text, { deferred: true, text: 'abc' }, 'N')?.deferred === true && answerFor(choice, { deferred: true, choice: 'v1' }, 'N')?.deferred === true);
  check('a question that does not allow deferring cannot be deferred', answerFor(strict, { deferred: true, choice: 'a' }, 'N')?.answer === 'a' && answerFor(confirm, { deferred: true }, 'N') === undefined);
  check('with no owner typed and no name to fall back on, a deferral is not an answer yet, and the form can say which', answerFor(text, { deferred: true }, '  ') === undefined && needsOwner([text], { q3: { deferred: true } }, '').join() === 'q3' && needsOwner([text], { q3: { deferred: true, owner: 'Ana' } }, '').length === 0 && needsOwner([text], { q3: { deferred: true } }, 'Newton').length === 0);
  const some = buildAnswers(all, { q1: { choice: 'v1' }, q3: { text: 'cinco' }, q4: { confirm: false } }, 'Newton');
  check('partial answers are fine ("Responder depois"): only what was answered is returned, in order', some.map((a) => a.id).join() === 'q1,q3,q4' && answeredCount(all, { q1: { choice: 'v1' } }, 'N') === 1);
  check('every answer has only the fields the engine expects', some.every((a) => Object.keys(a).every((k) => ['id', 'answer', 'deferred', 'owner'].includes(k))));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll interaction logic checks passed.');
