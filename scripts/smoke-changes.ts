import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaAgent } from '../src/core/agent/agentLoop.js';
import { AgentEvent } from '../src/core/agent/events.js';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { ChangeTracker, FileChange, MAX_TRACKED_CHARS } from '../src/core/changes/changeTracker.js';
import { ToolRegistry } from '../src/core/tools/index.js';
import { writeFileTool } from '../src/core/tools/writeFile.js';
import { editFileTool } from '../src/core/tools/editFile.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import { FakeModel, ScriptedTurn } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-changes-'));
let n = 0;
const mk = (label: string) => {
  const dir = path.join(tmp, `${label}-${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const read = (...p: string[]) => fs.readFileSync(path.join(...p), 'utf8');
const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };

/** Runs a scripted conversation in a fresh workspace and returns the session, events and workspace. */
async function run(turns: ScriptedTurn[], setup?: (ws: string) => void) {
  const ws = mk('ws');
  setup?.(ws);
  const events: AgentEvent[] = [];
  const model = new FakeModel(turns);
  const session = createSession({ workspace: ws, config, client: model.client, skillRoots: [], autoApprove: true, permissionsDir: path.join(tmp, 'perm'), onEvent: (e) => events.push(e) });
  await session.run('go');
  return { session, events, ws, model };
}
const write = (p: string, content: string, id?: string) => ({ name: 'write_file', args: { path: p, content }, id });
const edit = (p: string, target: string, replacement: string) => ({ name: 'edit_file', args: { path: p, target, replacement } });
const finished = (events: AgentEvent[]) => events.filter((e) => e.type === 'tool_call_finished') as any[];

/** Applies the diff with git to a copy of the "before" file and checks the result equals "after". */
function patchReproducesAfter(change: FileChange, patch: string): boolean {
  const dir = mk('apply');
  if (change.before !== null) {
    fs.mkdirSync(path.dirname(path.join(dir, change.path)), { recursive: true });
    fs.writeFileSync(path.join(dir, change.path), change.before);
  }
  const patchFile = path.join(mk('patch'), 'x.patch');
  fs.writeFileSync(patchFile, patch);
  try {
    // autocrlf off: this checks the diff, not this machine's line-ending settings.
    execFileSync('git', ['-c', 'core.autocrlf=false', 'apply', patchFile], { cwd: dir, stdio: 'pipe' });
  } catch {
    return false;
  }
  return fs.existsSync(path.join(dir, change.path)) && fs.readFileSync(path.join(dir, change.path), 'utf8') === change.after;
}

console.log('\n=== write_file records created and overwritten files ===');
{
  const { session, events, ws } = await run(
    [
      { toolCalls: [{ name: 'write_file', args: { path: 'src/deep/new.txt', content: 'SECRET-CONTENT line 1\nline 2\n' } }, { name: 'write_file', args: { path: 'old.txt', content: 'one\nTWO\nthree\n' } }] },
      { content: 'done' },
    ],
    (w) => fs.writeFileSync(path.join(w, 'old.txt'), 'one\ntwo\nthree\n')
  );
  const list = session.changes.list();
  check('both files are tracked, in the order they were touched', list.map((c) => c.path).join() === 'src/deep/new.txt,old.txt', list.map((c) => c.path).join());
  const created = list[0];
  check('a new file: before is null, after is what was written', created.kind === 'created' && created.before === null && created.after === 'SECRET-CONTENT line 1\nline 2\n' && created.added === 2 && created.removed === 0);
  check('the folders the write created are remembered', created.createdDirs.length === 2 && created.createdDirs[0].endsWith('src'));
  const over = list[1];
  check('an overwrite: before and after, with line counts', over.kind === 'modified' && over.before === 'one\ntwo\nthree\n' && over.after === 'one\nTWO\nthree\n' && over.added === 1 && over.removed === 1);
  const fin = finished(events);
  check('each tool_call_finished lists what that call wrote', JSON.stringify(fin[0].changes) === JSON.stringify([{ path: 'src/deep/new.txt', kind: 'created', added: 2, removed: 0 }]) && fin[1].changes[0].kind === 'modified');
  check('the change summaries carry no file content (only path, kind, line counts)', !JSON.stringify(fin.map((e) => e.changes)).includes('SECRET-CONTENT'));
  check('a call that wrote nothing has no changes field', !('changes' in finished((await run([{ toolCalls: [{ name: 'list_files', args: { path: '.' } }] }, { content: 'x' }])).events)[0]));
  check('the files are really on disk', read(ws, 'src/deep/new.txt').startsWith('SECRET'));
}

console.log('\n=== edit_file, several edits to one file => one net change ===');
{
  const { session, events } = await run(
    [
      { toolCalls: [edit('f.ts', 'alpha', 'ALPHA')] },
      { toolCalls: [edit('f.ts', 'gamma', 'GAMMA')] },
      { content: 'done' },
    ],
    (w) => fs.writeFileSync(path.join(w, 'f.ts'), 'alpha\nbeta\ngamma\n')
  );
  const list = session.changes.list();
  check('one entry for the file', list.length === 1 && list[0].path === 'f.ts');
  check('before is the original, after is the final state', list[0].before === 'alpha\nbeta\ngamma\n' && list[0].after === 'ALPHA\nbeta\nGAMMA\n' && list[0].added === 2 && list[0].removed === 2);
  const fin = finished(events);
  check('...while each call reports only its own change', fin[0].changes[0].added === 1 && fin[1].changes[0].added === 1);
}

console.log('\n=== diff(): valid unified diffs ===');
{
  const { session } = await run(
    [
      {
        toolCalls: [
          write('docs/new.md', '# Title\n\nbody\n'),
          write('tricky.txt', 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nM\nn\no\np\nq\nr\ns\nt'), // no trailing newline
          write('crlf.txt', 'one\r\nTWO\r\nthree\r\n'),
          edit('gone.txt', 'remove me\n', ''),
        ],
      },
      { content: 'done' },
    ],
    (w) => {
      fs.writeFileSync(path.join(w, 'tricky.txt'), 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl\nm\nn\no\np\nq\nr\ns\nt\n');
      fs.writeFileSync(path.join(w, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
      fs.writeFileSync(path.join(w, 'gone.txt'), 'keep\nremove me\nkeep\n');
    }
  );
  const created = session.changes.diff('docs/new.md')!;
  check('a created file diffs against /dev/null, with a hunk header', created.startsWith('--- /dev/null\n+++ b/docs/new.md\n') && created.includes('@@') && created.includes('+# Title'), created.slice(0, 120));
  const mod = session.changes.diff('tricky.txt')!;
  check('a modified file shows a/ b/ names, - and + lines', mod.startsWith('--- a/tricky.txt\n+++ b/tricky.txt\n') && mod.includes('-m\n') && mod.includes('+M\n'));
  check('...and notes a missing newline at the end', mod.includes('No newline at end of file'));
  check('there is no "Index:" banner', !created.includes('Index:') && !mod.includes('Index:'));
  for (const c of session.changes.list()) {
    check(`git apply reproduces ${c.path} exactly from its before-state`, patchReproducesAfter(c, session.changes.diff(c.path)!), session.changes.diff(c.path)!.slice(0, 200));
  }
  check('an unknown file has no diff', session.changes.diff('nope.txt') === undefined);
  check('paths are found however they are written (./, absolute, case on Windows)', session.changes.get('./docs/new.md') !== undefined && session.changes.get(path.join(session.workspace, 'docs', 'new.md')) !== undefined && (process.platform !== 'win32' || session.changes.get('DOCS/NEW.MD') !== undefined));
}

console.log('\n=== revert() ===');
{
  const { session, ws } = await run(
    [
      {
        toolCalls: [
          write('made/by/agent.txt', 'agent file\n'),
          write('crlf.txt', 'one\r\nTWO\r\nthree\r\n'),
          write('keep.txt', 'agent version\n'),
          write('existing-dir/new.txt', 'x\n'),
        ],
      },
      { content: 'done' },
    ],
    (w) => {
      fs.writeFileSync(path.join(w, 'crlf.txt'), 'one\r\ntwo\r\nthree\r\n');
      fs.writeFileSync(path.join(w, 'keep.txt'), 'original\n');
      fs.mkdirSync(path.join(w, 'existing-dir'));
    }
  );
  check('four pending changes', session.changes.size === 4);

  const part = session.changes.revert(['keep.txt']);
  check('revert(paths) restores only those files', part.reverted.join() === 'keep.txt' && read(ws, 'keep.txt') === 'original\n' && session.changes.size === 3 && read(ws, 'crlf.txt').includes('TWO'));
  const unknown = session.changes.revert(['not-tracked.txt']);
  check('an untracked path is reported, not touched', unknown.skipped.length === 1 && unknown.skipped[0].reason === 'unknown' && unknown.reverted.length === 0);

  const all = session.changes.revert();
  check('revert() undoes every pending change', all.reverted.length === 3 && all.skipped.length === 0 && session.changes.size === 0, JSON.stringify(all));
  check('a modified file comes back byte for byte (CRLF kept)', fs.readFileSync(path.join(ws, 'crlf.txt'), 'utf8') === 'one\r\ntwo\r\nthree\r\n');
  check('a file the agent created is deleted', !fs.existsSync(path.join(ws, 'made', 'by', 'agent.txt')));
  check('...along with the folders it had to create', !fs.existsSync(path.join(ws, 'made')));
  check('...but a folder that already existed stays', fs.existsSync(path.join(ws, 'existing-dir')) && !fs.existsSync(path.join(ws, 'existing-dir', 'new.txt')));

  // A created folder that gained a file of the user's is left alone.
  const { session: s2, ws: ws2 } = await run([{ toolCalls: [write('newdir/agent.txt', 'a\n')] }, { content: 'x' }]);
  fs.writeFileSync(path.join(ws2, 'newdir', 'users-own.txt'), 'precious');
  const r2 = s2.changes.revert();
  check("a created folder holding someone else's file is not removed", r2.reverted.length === 1 && fs.existsSync(path.join(ws2, 'newdir', 'users-own.txt')) && read(ws2, 'newdir', 'users-own.txt') === 'precious' && !fs.existsSync(path.join(ws2, 'newdir', 'agent.txt')));
}

console.log('\n=== revert() never overwrites work done after the agent ===');
{
  const { session, ws } = await run([{ toolCalls: [write('a.txt', 'agent\n'), write('b.txt', 'agent b\n'), write('c.txt', 'agent c\n')] }, { content: 'x' }], (w) => {
    fs.writeFileSync(path.join(w, 'a.txt'), 'original a\n');
    fs.writeFileSync(path.join(w, 'b.txt'), 'original b\n');
    fs.writeFileSync(path.join(w, 'c.txt'), 'original c\n');
  });
  fs.writeFileSync(path.join(ws, 'a.txt'), 'agent\nplus the user typed this\n'); // edited after the agent
  fs.rmSync(path.join(ws, 'b.txt')); // deleted after the agent
  const r = session.changes.revert();
  check('the edited and the deleted file are skipped and reported', r.skipped.map((s) => `${s.path}:${s.reason}`).sort().join() === 'a.txt:modified,b.txt:modified', JSON.stringify(r));
  check("the user's edit is untouched", read(ws, 'a.txt') === 'agent\nplus the user typed this\n' && !fs.existsSync(path.join(ws, 'b.txt')));
  check('the untouched file was still reverted', r.reverted.join() === 'c.txt' && read(ws, 'c.txt') === 'original c\n');
  check('skipped changes stay pending', session.changes.list().map((c) => c.path).sort().join() === 'a.txt,b.txt');
}

console.log('\n=== keep() ===');
{
  const { session, ws } = await run([{ toolCalls: [write('k1.txt', '1\n'), write('k2.txt', '2\n'), write('k3.txt', '3\n')] }, { content: 'x' }]);
  check('keep(paths) forgets just those', session.changes.keep(['k1.txt']) === 1 && session.changes.list().map((c) => c.path).join() === 'k2.txt,k3.txt');
  check('keep() with nothing named clears all and says how many', session.changes.keep() === 2 && session.changes.size === 0);
  check('the files are untouched', read(ws, 'k1.txt') === '1\n' && read(ws, 'k3.txt') === '3\n');
  check('there is nothing left to revert', session.changes.revert().reverted.length === 0 && fs.existsSync(path.join(ws, 'k2.txt')));
}

console.log('\n=== net-zero edits and edits made by someone else in between ===');
{
  const ws = mk('ws');
  const tracker = new ChangeTracker(ws);
  const tools = new ToolRegistry();
  const ctx = (extra = {}) => ({ workingDirectory: ws, safetyChecker: new SafetyChecker(true), contextManager: new ContextManager(), recordChange: (c: any) => tracker.record(c), ...extra });
  const w = (p: string, content: string) => writeFileTool.execute({ path: p, content }, ctx());
  const e = (p: string, target: string, replacement: string) => editFileTool.execute({ path: p, target, replacement }, ctx());
  void tools;

  fs.writeFileSync(path.join(ws, 'z.txt'), 'start\n');
  await e('z.txt', 'start', 'middle');
  check('one pending change', tracker.size === 1);
  await e('z.txt', 'middle', 'start');
  check('editing back to the original leaves nothing to review', tracker.size === 0);
  await w('z.txt', 'start\n');
  check('re-writing identical content records nothing', tracker.size === 0);

  // agent: A -> B, user: B -> C, agent: C -> D. Undo must restore C (the user's), not A.
  fs.writeFileSync(path.join(ws, 'u.txt'), 'A\n');
  await w('u.txt', 'B\n');
  fs.writeFileSync(path.join(ws, 'u.txt'), 'C\n');
  await w('u.txt', 'D\n');
  const entry = tracker.get('u.txt')!;
  check("the user's edit in between becomes the new baseline", entry.before === 'C\n' && entry.after === 'D\n');
  tracker.revert();
  check("Undo restores the user's version, not the original", read(ws, 'u.txt') === 'C\n');

  // created by the agent, then edited again by the agent: still "created"; undo deletes it.
  await w('fresh.txt', 'v1\n');
  await e('fresh.txt', 'v1', 'v2');
  check('a created file edited again is still one created file', tracker.get('fresh.txt')!.kind === 'created' && tracker.get('fresh.txt')!.after === 'v2\n' && tracker.get('fresh.txt')!.before === null);
  tracker.revert();
  check('...and undo deletes it', !fs.existsSync(path.join(ws, 'fresh.txt')));
}

console.log('\n=== what cannot be tracked is shown, not hidden ===');
{
  const { session, events, ws } = await run(
    [{ toolCalls: [write('logo.png', 'not really a png'), write('huge.txt', 'x'.repeat(MAX_TRACKED_CHARS + 10)), write('plain.txt', 'fine\n')] }, { content: 'x' }],
    (w) => fs.writeFileSync(path.join(w, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]))
  );
  const byPath = Object.fromEntries(session.changes.list().map((c) => [c.path, c]));
  check('a binary file is listed as untracked, with no content kept', byPath['logo.png'].kind === 'untracked' && byPath['logo.png'].untracked === 'binary' && byPath['logo.png'].before === null && byPath['logo.png'].after === null);
  check('a file over the size limit too', byPath['huge.txt'].kind === 'untracked' && byPath['huge.txt'].untracked === 'too_large');
  check('events say so', finished(events)[0].changes[0].kind === 'untracked' && finished(events)[1].changes[0].kind === 'untracked');
  check('their diff is a note, not a crash', session.changes.diff('logo.png')!.includes('binary file') && session.changes.diff('huge.txt')!.includes('too large'));
  const r = session.changes.revert();
  check('they are skipped on undo (and reported), the normal file is reverted', r.skipped.map((s) => s.path).sort().join() === 'huge.txt,logo.png' && r.skipped.every((s) => s.reason === 'untracked') && r.reverted.join() === 'plain.txt');
  check('nothing was overwritten', fs.readFileSync(path.join(ws, 'logo.png'), 'utf8') === 'not really a png' && !fs.existsSync(path.join(ws, 'plain.txt')));
}

console.log('\n=== subagents, outside paths, failures, and the known limit ===');
{
  const ws = mk('ws');
  const events: AgentEvent[] = [];
  const model = new FakeModel([
    { toolCalls: [{ name: 'run_subagent', args: { task: 'write the file' } }] },
    { toolCalls: [{ name: 'write_file', args: { path: 'child.txt', content: 'from the child\n' } }] },
    { content: 'STATUS: completed\nSUMMARY: wrote it\nARTIFACTS: child.txt' },
    { content: 'all done' },
  ]);
  const session = createSession({ workspace: ws, config, client: model.client, skillRoots: [], autoApprove: true, permissionsDir: path.join(tmp, 'perm'), onEvent: (e) => events.push(e) });
  await session.run('delegate');
  check("a subagent's write is tracked by the session", session.changes.list().map((c) => c.path).join() === 'child.txt');
  const childFin = finished(events).find((e) => e.subagentId);
  check("...and its event carries the change, tagged as the child's", childFin?.changes?.[0]?.path === 'child.txt' && childFin.changes[0].kind === 'created');

  const outside = path.join(mk('elsewhere'), 'out.txt');
  const o = await run([{ toolCalls: [write(outside, 'outside\n')] }, { content: 'x' }]);
  check('a file outside the workspace is tracked by absolute path', o.session.changes.list()[0].path === outside && o.session.changes.revert().reverted.length === 1 && !fs.existsSync(outside));

  const f = await run(
    [{ toolCalls: [edit('missing.txt', 'a', 'b'), edit('f.txt', 'not in the file', 'x'), { name: 'write_file', args: { path: 'adir', content: 'x' } }] }, { content: 'x' }],
    (w) => {
      fs.writeFileSync(path.join(w, 'f.txt'), 'content\n');
      fs.mkdirSync(path.join(w, 'adir'));
    }
  );
  check('a failed write records nothing', f.session.changes.size === 0 && finished(f.events).every((e) => e.isError && !('changes' in e)));

  const bash = await run([{ toolCalls: [{ name: 'run_bash', args: { command: 'echo hi > made-by-shell.txt' } }] }, { content: 'x' }]);
  check('KNOWN LIMIT: a file made by run_bash is not tracked', fs.existsSync(path.join(bash.ws, 'made-by-shell.txt')) && bash.session.changes.size === 0);

  // An agent without a tracker still reports the summary in its events.
  const evs: AgentEvent[] = [];
  const ws2 = mk('ws');
  const agent = new AliaAgent({
    client: new FakeModel([{ toolCalls: [write('t.txt', 'a\nb\n')] }, { content: 'x' }]).client,
    model: 'fake-model',
    modelConfig: config.models[0],
    toolRegistry: new ToolRegistry(),
    safetyChecker: new SafetyChecker(true),
    contextManager: new ContextManager(),
    workingDirectory: ws2,
    onEvent: (e) => evs.push(e),
  });
  await agent.runDetailed('go');
  check('without a tracker the events still describe the write', finished(evs)[0].changes[0].path === 't.txt' && finished(evs)[0].changes[0].added === 2);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll change tracking checks passed.');
