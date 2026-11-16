import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaAgent } from '../src/agent/agentLoop.js';
import { ToolRegistry } from '../src/tools/index.js';
import {
  createRunSubagentTool,
  SUBAGENT_PROMPT_BLOCK,
  MAX_SUBAGENT_STEPS,
} from '../src/tools/runSubagent.js';
import { SafetyChecker } from '../src/safety/safetyChecker.js';
import { ContextManager } from '../src/context/contextManager.js';
import {
  parseSubagentReport,
  formatSubagentReport,
  MAX_RESULT_CHARS,
} from '../src/agent/subagentResult.js';
import { FakeModel, ScriptedTurn, RecordedRequest } from './lib/fakeModel.js';
import { quiet } from './lib/testUtils.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-subagents-'));
const PARENT_PROMPT = 'PARENT SYSTEM PROMPT';

/**
 * One FakeModel serves parent and child (they share the client), so the script is the
 * interleaved sequence of model calls: parent, child..., parent.
 */
function setup(turns: ScriptedTurn[], opts: { repeatLast?: boolean } = {}) {
  const model = new FakeModel(turns, opts.repeatLast ? 'repeat-last' : 'throw');
  const tools = new ToolRegistry();
  const modelConfig = { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true };
  tools.register(
    createRunSubagentTool({
      getClient: () => model.client,
      getModel: () => ({ id: 'fake-model', config: modelConfig }),
      getRegistry: () => tools,
      systemPrompt: PARENT_PROMPT,
    })
  );
  const parent = new AliaAgent({
    client: model.client,
    model: 'fake-model',
    modelConfig,
    toolRegistry: tools,
    safetyChecker: new SafetyChecker(true),
    contextManager: new ContextManager(),
    workingDirectory: tmp,
    systemPrompt: PARENT_PROMPT,
  });
  return { model, tools, parent };
}

const lastTool = (req: RecordedRequest) =>
  [...req.messages].reverse().find((m) => m.role === 'tool')?.content as string;
const delegate = (task: string, extra: object = {}): ScriptedTurn => ({
  toolCalls: [{ name: 'run_subagent', args: { task, ...extra } }],
});
const relay: ScriptedTurn = (req) => ({ content: lastTool(req) });

console.log('\n=== S3: ToolRegistry.without ===');
{
  const base = new ToolRegistry();
  const slim = base.without(['run_bash', 'grep_search'], 'nope: custom reason');
  check('removed tools are gone from the copy', !slim.get('run_bash') && !slim.get('grep_search'));
  check('original registry untouched', !!base.get('run_bash') && !!base.get('grep_search'));
  check('other tools kept', !!slim.get('read_file') && slim.getAll().length === base.getAll().length - 2);
  check('removed tools not advertised to the model', !slim.getOpenAITools().some((t) => (t as any).function.name === 'run_bash'));
  const ctx = { workingDirectory: tmp, safetyChecker: new SafetyChecker(true), contextManager: new ContextManager() };
  check('calling a removed tool gives the custom reason', (await slim.execute('run_bash', '{}', ctx)) === 'Error: nope: custom reason');
  check('truly unknown tool keeps the generic error', (await slim.execute('zzz', '{}', ctx)).includes('is not registered'));
  const chained = slim.without(['read_file']);
  check('withheld reasons survive chaining', (await chained.execute('run_bash', '{}', ctx)).includes('custom reason'));
}

console.log('\n=== result contract: parse / format ===');
{
  const full = parseSubagentReport(
    'Some chatter first.\nSTATUS: completed\nSUMMARY: wrote the spec\nand checked it\nARTIFACTS: docs/a.md, docs/b.md\n'
  );
  check('parses status', full.status === 'completed');
  check('multi-line summary kept', full.summary === 'wrote the spec\nand checked it');
  check('artifacts split', full.artifacts.length === 2 && full.artifacts[1] === 'docs/b.md');

  const lenient = parseSubagentReport('**Status:** BLOCKED\n- **Summary:** need input\n- Artifacts: `docs/q.md`\nQuestions:\n1. Which DB?\n2. Which auth?');
  check('lenient about markdown/case', lenient.status === 'blocked' && lenient.summary === 'need input');
  check('strips backticks from paths', lenient.artifacts[0] === 'docs/q.md');
  check('questions keep their lines', lenient.questions.includes('1. Which DB?') && lenient.questions.includes('2. Which auth?'));

  const last = parseSubagentReport('STATUS: failed\nSUMMARY: first try\n\nSTATUS: completed\nSUMMARY: second try');
  check('last STATUS block wins', last.status === 'completed' && last.summary === 'second try');

  const none = parseSubagentReport('I just did the thing, no block.');
  check('no block -> completed with whole text as summary', none.status === 'completed' && none.summary === 'I just did the thing, no block.');
  check('"none" artifacts ignored', parseSubagentReport('STATUS: completed\nSUMMARY: x\nARTIFACTS: none').artifacts.length === 0);
  check('"done" normalised to completed', parseSubagentReport('STATUS: done\nSUMMARY: x').status === 'completed');

  const out = formatSubagentReport({ status: 'blocked', summary: 's', artifacts: ['a.md'], questions: 'q?' }, { steps: 3, maxSteps: 40 });
  check('format renders all fields', out === 'STATUS: blocked\nSTEPS: 3/40\nSUMMARY: s\nARTIFACTS: a.md\nQUESTIONS: q?', out);
  const huge = formatSubagentReport({ status: 'completed', summary: 'x'.repeat(20000), artifacts: [], questions: '' });
  check(`result capped at ${MAX_RESULT_CHARS} chars`, huge.length <= MAX_RESULT_CHARS && huge.includes('truncated'));
}

console.log('\n=== S4: isolation + happy path ===');
{
  const { model, parent } = setup([
    delegate('Write docs/out.md with a haiku.', { max_steps: 10 }), // call 1: parent
    { toolCalls: [{ name: 'write_file', args: { path: 'docs/out.md', content: 'old pond' } }] }, // call 2: child
    { content: 'STATUS: completed\nSUMMARY: wrote the haiku\nARTIFACTS: docs/out.md' }, // call 3: child
    relay, // call 4: parent
  ]);
  const r = await quiet(() => parent.runDetailed('please delegate'));
  check('parent completed', r.status === 'completed', JSON.stringify(r));
  check('parent got a structured result', r.text.startsWith('STATUS: completed') && r.text.includes('ARTIFACTS: docs/out.md'), r.text);
  check('result reports steps vs cap', r.text.includes('STEPS: 2/10'), r.text);
  check('child really wrote the artifact', fs.readFileSync(path.join(tmp, 'docs', 'out.md'), 'utf8') === 'old pond');

  const childFirst = model.requests[1];
  check('child starts from a clean history (system + task only)', childFirst.messages.length === 2 && childFirst.messages[1].role === 'user');
  check('child task is its first user message', childFirst.messages[1].content === 'Write docs/out.md with a haiku.');
  check('child system prompt = parent prompt + subagent block', childFirst.messages[0].content === `${PARENT_PROMPT}\n\n${SUBAGENT_PROMPT_BLOCK}`);
  check('child cannot see run_subagent', !childFirst.toolNames.includes('run_subagent') && childFirst.toolNames.includes('write_file'));
  check('parent DOES see run_subagent', model.requests[0].toolNames.includes('run_subagent'));
  check('child saw nothing of the parent conversation', !JSON.stringify(childFirst.messages).includes('please delegate'));

  const msgs = parent.getMessages();
  check('parent history: system,user,assistant(call),tool,assistant', msgs.length === 5, `len=${msgs.length}`);
  check('child messages never leaked into parent history', !JSON.stringify(msgs).includes('write_file') && !JSON.stringify(msgs).includes('old pond'));
}

console.log('\n=== S4: depth guard ===');
{
  const { model, parent } = setup([
    delegate('try to recurse'), // parent
    { toolCalls: [{ name: 'run_subagent', args: { task: 'grandchild' } }] }, // child tries to recurse
    (req) => ({ content: `STATUS: completed\nSUMMARY: child saw: ${lastTool(req)}` }), // child reports what it got
    relay,
  ]);
  const r = await quiet(() => parent.runDetailed('go'));
  check('recursion attempt got a clear error', r.text.includes('subagents cannot start other subagents'), r.text);
  check('no grandchild was spawned (4 model calls total)', model.callCount === 4, `calls=${model.callCount}`);
}

console.log('\n=== S4: step budget ===');
{
  const loop: ScriptedTurn = { toolCalls: [{ name: 'list_files', args: { path: '.' } }] };
  // Script order: parent (delegate), child x3 (loop until its cap), parent (relay result).
  const exact = setup([delegate('loop', { max_steps: 3 }), loop, loop, loop, relay]);
  const r = await quiet(() => exact.parent.runDetailed('go'));
  check('child hitting its cap reports max_steps', r.text.startsWith('STATUS: max_steps') && r.text.includes('STEPS: 3/3'), r.text);
  check('child used exactly its budget (+2 parent calls)', exact.model.callCount === 5);

  // A request far above the hard cap must be clamped: the child gets exactly MAX_SUBAGENT_STEPS calls.
  const capped = setup([
    delegate('loop', { max_steps: 9999 }),
    ...Array.from({ length: MAX_SUBAGENT_STEPS }, () => loop),
    relay,
  ]);
  const rc = await quiet(() => capped.parent.runDetailed('go'));
  check(`max_steps above ${MAX_SUBAGENT_STEPS} is clamped`, rc.text.includes(`STEPS: ${MAX_SUBAGENT_STEPS}/${MAX_SUBAGENT_STEPS}`), rc.text);
}

console.log('\n=== S4: failure paths ===');
{
  const apiErr = setup([delegate('x'), { throws: 'endpoint down' }, relay]);
  const r1 = await quiet(() => apiErr.parent.runDetailed('go'));
  check('child API error -> STATUS: failed with cause', r1.text.startsWith('STATUS: failed') && r1.text.includes('endpoint down'), r1.text);
  check('parent itself still completes', r1.status === 'completed');

  const ghost = setup([
    delegate('x'),
    { content: 'STATUS: completed\nSUMMARY: all done\nARTIFACTS: docs/never-written.md' },
    relay,
  ]);
  const r2 = await quiet(() => ghost.parent.runDetailed('go'));
  check('fabricated artifact -> downgraded to failed', r2.text.startsWith('STATUS: failed') && r2.text.includes('docs/never-written.md'), r2.text);

  const empty = setup([delegate('   '), relay]);
  const r3 = await quiet(() => empty.parent.runDetailed('go'));
  check('blank task is rejected without spawning a child', r3.text.startsWith('Error: Parameter "task"') && empty.model.callCount === 2, r3.text);
}

console.log('\n=== S4: blocked-at-gate result ===');
{
  const { parent } = setup([
    delegate('stage 1'),
    { content: 'STATUS: blocked\nSUMMARY: ambiguous input\nQUESTIONS: Which tenant model?\nARTIFACTS: none' },
    relay,
  ]);
  const r = await quiet(() => parent.runDetailed('go'));
  check('blocked status and questions surface to the parent', r.text.startsWith('STATUS: blocked') && r.text.includes('QUESTIONS: Which tenant model?'), r.text);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll subagent checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
