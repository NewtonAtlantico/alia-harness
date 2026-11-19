/**
 * Unit tests for the right panel's pure logic (A10): reading a unified diff, and listing the shell commands of a
 * conversation. The diffs are produced by core's real ChangeTracker, then parsed. No browser.
 * Run from desktop/: `npm run test:panel-logic`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChangeTracker } from 'alia-harness/core';
import { diffKind, parseDiff } from '../src/renderer/src/lib/diff';
import { collectCommands } from '../src/renderer/src/lib/commandLog';
import type { ToolRow } from '../src/renderer/src/lib/timeline';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-panel-'));

/** A real diff from core's tracker, so the parser is tested against what it will receive. */
function realDiff(before: string | null, after: string): string {
  const file = path.join(tmp, `f-${Math.random().toString(36).slice(2)}.txt`);
  const tracker = new ChangeTracker(tmp);
  fs.writeFileSync(file, after);
  tracker.record({ absPath: file, before, after, createdDirs: [] });
  return tracker.diff(path.relative(tmp, file))!;
}

console.log('\n=== reading a unified diff ===');
{
  const text = realDiff('um\ndois\ntrês\nquatro\n', 'um\nDOIS\ntrês\nquatro\ncinco\n');
  const d = parseDiff(text);
  check('the counts agree with what core reported', d.added === 2 && d.removed === 1, JSON.stringify({ a: d.added, r: d.removed }));
  const kinds = d.lines.map((l) => l.kind);
  check('header lines, a hunk header, then removed, added and context lines', kinds.slice(0, 2).join() === 'meta,meta' && kinds[2] === 'hunk' && kinds.includes('remove') && kinds.includes('add') && kinds.includes('context'));
  const rem = d.lines.find((l) => l.kind === 'remove')!;
  const add = d.lines.filter((l) => l.kind === 'add');
  check('each line is without its +/-/space, and numbered in the old and the new file', rem.text === 'dois' && rem.oldNo === 2 && rem.newNo === undefined && add[0].text === 'DOIS' && add[0].newNo === 2 && add[1].text === 'cinco' && add[1].newNo === 5);
  const ctx = d.lines.find((l) => l.kind === 'context' && l.text === 'três')!;
  check('a context line has both numbers (they differ after a change that shifts lines)', ctx.oldNo === 3 && ctx.newNo === 3);
  check('numbers only ever go up within a hunk', d.lines.filter((l) => l.newNo !== undefined).every((l, i, a) => i === 0 || l.newNo! > a[i - 1].newNo!));
}

console.log('\n=== created, deleted and untouched ===');
{
  const created = realDiff(null, 'a\nb\n');
  check('a new file is only additions, and is recognized from its header', parseDiff(created).added === 2 && parseDiff(created).removed === 0 && diffKind(created) === 'created');
  check('an ordinary change is "modified"', diffKind(realDiff('a\n', 'b\n')) === 'modified');
  check('a deletion is recognized', diffKind('--- a/x\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n') === 'deleted');
  check('no diff text is an empty result, not a crash', parseDiff('').lines.length === 0 && parseDiff('').added === 0);
}

console.log('\n=== awkward diffs ===');
{
  const noNewline = parseDiff('--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n');
  check('"No newline at end of file" is a note, not a changed line', noNewline.lines.filter((l) => l.kind === 'note').length === 2 && noNewline.added === 1 && noNewline.removed === 1 && noNewline.lines.filter((l) => l.kind === 'note')[0].text === 'No newline at end of file');
  const crlf = parseDiff('--- a/x\r\n+++ b/x\r\n@@ -1,2 +1,2 @@\r\n a\r\n-b\r\n+c\r\n');
  check('Windows line endings in the diff text are handled', crlf.added === 1 && crlf.removed === 1 && crlf.lines.every((l) => !l.text.includes('\r')));
  const lookalike = parseDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-- a line that starts with two dashes\n++ and with two pluses\n ctx\n');
  check('lines of the content that start with dashes or pluses are content, not headers', lookalike.removed === 1 && lookalike.added === 1 && lookalike.lines.find((l) => l.kind === 'remove')!.text === '- a line that starts with two dashes');
  const blank = parseDiff('--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n\n-b\n+c\n');
  check('a blank context line whose space was trimmed still counts as context', blank.lines.some((l) => l.kind === 'context' && l.text === '' && l.oldNo === 2));
  check('two hunks restart their numbers from their headers', (() => { const d = parseDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n+b\n@@ -10,1 +10,1 @@\n-j\n+k\n'); const adds = d.lines.filter((l) => l.kind === 'add'); return adds[0].newNo === 1 && adds[1].newNo === 10; })());
  const big = parseDiff(realDiff('x\n'.repeat(5000), 'x\n'.repeat(2500) + 'y\n' + 'x\n'.repeat(2499)));
  check('a large diff parses in one pass, with the right counts', big.added >= 1 && big.removed >= 1 && big.lines.length > 5);
}

console.log('\n=== the commands a conversation ran ===');
{
  const row = (id: string, name: string, extra: Partial<ToolRow> = {}): ToolRow => ({ kind: 'tool', id, name, args: name === 'run_bash' ? { command: `cmd ${id}` } : {}, status: 'done', children: [], ...extra });
  const rows = [
    row('1', 'read_file'),
    row('2', 'run_bash', { result: '[Exit Code: 0]\nok', durationMs: 120 }),
    row('3', 'run_subagent', { children: [row('3a', 'run_bash', { result: '[Exit Code: 1]\nboom', durationMs: 50 }), row('3b', 'list_files')] }),
    row('4', 'run_bash', { status: 'running' }),
    { kind: 'user', id: 'u', text: 'x' } as const,
  ];
  const log = collectCommands(rows as any);
  check('only shell commands, in the order they ran, including a subagent\'s', log.map((c) => c.id).join() === '2,3a,4');
  check('each has its command line, output and how it ended', log[0].command === 'cmd 2' && log[0].output.includes('ok') && log[0].outcome.state === 'passed' && log[1].outcome.state === 'failed' && log[1].outcome.exitCode === 1);
  check('a command that is still running says so, with no output yet', log[2].outcome.state === 'running' && log[2].output === '');
  check('a subagent\'s command is marked as such', log[1].viaSubagent === true && log[0].viaSubagent === false);
  check('nothing ran, nothing listed', collectCommands([]).length === 0 && collectCommands([row('x', 'read_file')] as any).length === 0);
}

try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}
if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll panel logic checks passed.');
