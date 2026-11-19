import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaAgent } from '../src/core/agent/agentLoop.js';
import { ToolRegistry, ToolDefinition } from '../src/core/tools/index.js';
import { SkillRegistry, bundledSkillsDir } from '../src/core/skills/skillLoader.js';
import { TerminalUI } from '../src/cli/ui/terminal.js';
import {
  createRunSubagentTool,
  SUBAGENT_PROMPT_BLOCK,
  MAX_SUBAGENT_STEPS,
} from '../src/core/tools/runSubagent.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import {
  parseSubagentReport,
  formatSubagentReport,
  MAX_RESULT_CHARS,
} from '../src/core/agent/subagentResult.js';
import { FakeModel, ScriptedTurn, RecordedRequest } from './lib/fakeModel.js';
import { quiet, capture } from './lib/testUtils.js';

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
function setup(
  turns: ScriptedTurn[],
  opts: { repeatLast?: boolean; skills?: SkillRegistry; verbose?: boolean; extraTools?: ToolDefinition[] } = {}
) {
  const model = new FakeModel(turns, opts.repeatLast ? 'repeat-last' : 'throw');
  const tools = new ToolRegistry();
  for (const t of opts.extraTools ?? []) tools.register(t);
  const modelConfig = { id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true };
  tools.register(
    createRunSubagentTool({
      getClient: () => model.client,
      getModel: () => ({ id: 'fake-model', config: modelConfig }),
      getRegistry: () => tools,
      systemPrompt: PARENT_PROMPT,
      getSkills: opts.skills ? () => opts.skills! : undefined,
      verbose: opts.verbose ?? false,
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
    ui: TerminalUI,
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

  check('the child requests a stream too, silently (a long generation is not cut off by the headers timeout)', model.requests[1].stream === true);

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

console.log('\n=== S5: skill pre-load ===');
{
  const skills = new SkillRegistry({ roots: [{ label: 'bundled', dir: bundledSkillsDir() }], getToolNames: () => [] });
  skills.load();
  const done: ScriptedTurn = { content: 'STATUS: completed\nSUMMARY: ok' };

  const ok = setup([delegate('Break spec X into tasks', { skill: 'spec-to-tasks' }), done, relay], { skills });
  await quiet(() => ok.parent.runDetailed('go'));
  const first = ok.model.requests[1].messages[1].content as string;
  check('child first message carries the skill body', first.includes('<skill name="spec-to-tasks"'));
  check('child told not to re-load it', first.includes('do not call use_skill'));
  check('child first message carries the task', first.endsWith('Request / input: Break spec X into tasks'));

  const slash = setup([delegate('t', { skill: '/spec-to-tasks' }), done, relay], { skills });
  await quiet(() => slash.parent.runDetailed('go'));
  check('leading slash accepted', (slash.model.requests[1].messages[1].content as string).includes('<skill name="spec-to-tasks"'));

  const unknown = setup([delegate('t', { skill: 'nope' }), relay], { skills });
  const ru = await quiet(() => unknown.parent.runDetailed('go'));
  check('unknown skill -> Error listing skills, no child spawned', ru.text.startsWith('Error: Unknown skill "nope"') && ru.text.includes('spec-to-tasks') && unknown.model.callCount === 2, ru.text);

  const gated = setup([delegate('t', { skill: 'add-tasks-to-jira' }), relay], { skills });
  const rg = await quiet(() => gated.parent.runDetailed('go'));
  check('gated skill -> Error unavailable, no child spawned', rg.text.includes('unavailable') && gated.model.callCount === 2, rg.text);

  const noSkills = setup([delegate('t', { skill: 'spec-to-tasks' }), relay]);
  const rn = await quiet(() => noSkills.parent.runDetailed('go'));
  check('skill arg without a skill registry -> Error', rn.text.startsWith('Error: Skills are not available'), rn.text);
}

console.log('\n=== S5: inputs attachments ===');
{
  fs.mkdirSync(path.join(tmp, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'docs', 'in.md'), '# Spec\nUNIQUE-SPEC-MARKER');
  const done: ScriptedTurn = { content: 'STATUS: completed\nSUMMARY: ok' };

  const ok = setup([delegate('Summarise the spec', { inputs: ['docs/in.md', 'docs'] }), done, relay]);
  await quiet(() => ok.parent.runDetailed('go'));
  const first = ok.model.requests[1].messages[1].content as string;
  check('file contents attached to the child first message', first.includes('<file path="docs/in.md"') && first.includes('UNIQUE-SPEC-MARKER'));
  check('directory inputs are listed', first.includes('<directory path="docs"'));
  check('task text comes first', first.startsWith('Summarise the spec'));
  check('contents did not leak into the parent history', !JSON.stringify(ok.parent.getMessages()).includes('UNIQUE-SPEC-MARKER'));

  const missing = setup([delegate('t', { inputs: ['docs/in.md', 'docs/typo.md'] }), relay]);
  const rm = await quiet(() => missing.parent.runDetailed('go'));
  check('missing input -> Error naming it, no child spawned', rm.text.startsWith('Error: could not attach inputs') && rm.text.includes('docs/typo.md') && missing.model.callCount === 2, rm.text);

  const bad = setup([delegate('t', { inputs: 'docs/in.md' }), relay]);
  const rb = await quiet(() => bad.parent.runDetailed('go'));
  check('non-array inputs -> Error, no child spawned', rb.text.startsWith('Error: Parameter "inputs"') && bad.model.callCount === 2, rb.text);

  // docs/in.md exists, so a resolver run over the task text WOULD attach it; @ghost would error.
  const taskText = 'ping me@x.com, ask @ghost, see @docs/in.md';
  const mention = setup([delegate(taskText), done, relay]);
  const rt = await quiet(() => mention.parent.runDetailed('go'));
  check('@mentions inside the task text are left alone (only "inputs" attach files)', rt.text.startsWith('STATUS: completed') && mention.model.requests[1].messages[1].content === taskText, rt.text);

  const both = setup(
    [delegate('combine', { inputs: ['docs/in.md'], skill: 'spec-to-tasks' }), done, relay],
    { skills: (() => { const s = new SkillRegistry({ roots: [{ label: 'bundled', dir: bundledSkillsDir() }], getToolNames: () => [] }); s.load(); return s; })() }
  );
  await quiet(() => both.parent.runDetailed('go'));
  const combined = both.model.requests[1].messages[1].content as string;
  check('skill + inputs together: skill body, task and attachment all present', combined.includes('<skill name="spec-to-tasks"') && combined.includes('combine') && combined.includes('UNIQUE-SPEC-MARKER'));
}

console.log('\n=== S2: nested terminal output ===');
{
  const rec = (fn: () => void) => capture(async () => fn());

  const base = await rec(() => {
    TerminalUI.printToolCall('read_file', '{"path":"a.ts"}');
    TerminalUI.printToolResult('line1\nline2');
  });
  TerminalUI.pushScope({ label: 'x' });
  TerminalUI.popScope();
  const after = await rec(() => {
    TerminalUI.printToolCall('read_file', '{"path":"a.ts"}');
    TerminalUI.printToolResult('line1\nline2');
  });
  check('no scope: output unchanged and unaffected by a push/pop pair', base.text === after.text && base.lines.length > 0);
  check('no scope: no gutter', !base.text.includes('│ ●'));

  const verbose = await (async () => {
    TerminalUI.pushScope({ label: 'child', quiet: false });
    try {
      return await rec(() => {
        TerminalUI.printToolCall('read_file', '{"path":"a.ts"}');
        TerminalUI.printToolResult('line1\nline2');
        TerminalUI.printAssistantMessage('final words');
      });
    } finally {
      TerminalUI.popScope();
    }
  })();
  const vLines = verbose.text.split('\n').filter((l) => l.trim() !== '');
  check('verbose scope: every non-empty line sits under the gutter', vLines.length > 3 && vLines.every((l) => l.includes('│')), verbose.text);
  check('verbose scope: full detail kept (result preview + final message)', verbose.text.includes('line2') && verbose.text.includes('final words'));

  const quietOut = await (async () => {
    TerminalUI.pushScope({ label: 'child', quiet: true });
    try {
      return await rec(() => {
        TerminalUI.printThinking('secret reasoning');
        TerminalUI.printToolCall('write_file', '{"path":"a.ts","content":"' + 'x'.repeat(500) + '"}');
        TerminalUI.printToolResult('wrote it\nsecond line');
        TerminalUI.printToolResult('Error: boom\nmore', true);
        TerminalUI.printAssistantMessage('final words');
      });
    } finally {
      TerminalUI.popScope();
    }
  })();
  const qLines = quietOut.text.split('\n').filter((l) => l.trim() !== '');
  check('quiet scope: exactly a tool-call line and an error line', qLines.length === 2, JSON.stringify(qLines));
  check('quiet scope: call line names the tool, long args truncated', qLines[0].includes('write_file') && qLines[0].length < 160 && qLines[0].includes('…'));
  check('quiet scope: errors surface, one line', qLines[1].includes('Error: boom') && !quietOut.text.includes('more'));
  check('quiet scope: reasoning, ok-results and final message hidden', !/secret|wrote it|final words/.test(quietOut.text));

  TerminalUI.pushScope({ label: 'outer', quiet: false });
  TerminalUI.pushScope({ label: 'inner', quiet: false });
  const nested = await rec(() => TerminalUI.printInfo('deep'));
  check('label is the innermost scope', TerminalUI.getScopeLabel() === 'inner');
  TerminalUI.popScope();
  const shallow = await rec(() => TerminalUI.printInfo('deep'));
  TerminalUI.popScope();
  check('nested scope indents deeper than its parent', nested.text.indexOf('deep') > shallow.text.indexOf('deep'));
  check('scopes fully unwound', TerminalUI.getScopeLabel() === undefined);
}

console.log('\n=== S2: wired into run_subagent ===');
{
  const labels: (string | undefined)[] = [];
  const probe: ToolDefinition = {
    name: 'probe',
    description: 'records the active output scope label',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      labels.push(TerminalUI.getScopeLabel());
      return 'probed';
    },
  };
  const script = (): ScriptedTurn[] => [
    delegate('Probe things in a subagent'),
    { toolCalls: [{ name: 'probe', args: {} }] },
    { content: 'STATUS: completed\nSUMMARY: ok' },
    relay,
  ];

  const compact = setup(script(), { extraTools: [probe], verbose: false });
  const c = await capture(() => compact.parent.runDetailed('go'));
  check('child tool sees its scope label (used for approval prompts)', labels[0] === 'Probe things in a subagent', String(labels[0]));
  check('scope is gone once the child finishes', TerminalUI.getScopeLabel() === undefined);
  check('compact: child tool call shown on one gutter line', c.lines.some((l) => l.includes('│') && l.includes('probe')));
  const okCount = (t: string) => (t.match(/✓ ok/g) ?? []).length;
  check('compact: only the parent\'s tool result preview is printed', okCount(c.text) === 1, `ok=${okCount(c.text)}`);
  check('compact: start/finish lines frame the child', c.text.includes('Subagent started') && c.text.includes('Subagent finished: completed'));

  const full = setup(script(), { extraTools: [probe], verbose: true });
  const f = await capture(() => full.parent.runDetailed('go'));
  check('verbose: child result previews are shown too', okCount(f.text) === 2, `ok=${okCount(f.text)}`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? '\nAll subagent checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
