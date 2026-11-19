import fs from 'node:fs';
const edit = (file, pairs) => {
  let s = fs.readFileSync(file, 'utf8');
  for (const [a, b] of pairs) { if (!s.includes(a)) throw new Error(`missing in ${file}: ${a.slice(0, 80)}`); s = s.replace(a, () => b); }
  fs.writeFileSync(file, s);
};
edit('src/renderer/src/lib/timeline.ts', [
  ["  state: 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout' | 'denied' | 'error';", "  /** `unknown`: the result says nothing about how it ended (an archived output, for instance): no tag is better than a wrong one. */\n  state: 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout' | 'denied' | 'error' | 'unknown';"],
  [
    "  if (/^User denied permission/.test(result) || /^Error: .*denied/i.test(result)) return { state: 'denied' };\n  if (/^\[Execution timed out/m.test(result.slice(0, 200))) return { state: 'timeout' };\n  const code = /^\[Exit Code: (-?\d+)\]/.exec(result) ?? /\(exit code: (-?\d+)\)/.exec(result);\n  if (code) {\n    const exitCode = Number(code[1]);\n    return { state: exitCode === 0 ? 'passed' : 'failed', exitCode };\n  }\n  if (row.status === 'error' || isErrorResult(result)) return { state: 'error' };\n  return { state: 'passed', exitCode: 0 };",
    "  // Core's own refusals: the user cancelled before approving, said no, or there was nobody to ask.\n  if (/^Cancelled by user before/.test(result)) return { state: 'cancelled' };\n  if (/^User denied permission/.test(result) || /^Error: .*denied/i.test(result) || /needs the user's approval, but no confirmation handler/.test(result) || /^Potentially destructive command detected/.test(result)) return { state: 'denied' };\n  // An output archived to save context keeps its first characters, where the exit code is.\n  const head = result.replace(/^\[Previous tool output archived to save context: /, '').slice(0, 200);\n  if (/^\[Execution timed out/m.test(head)) return { state: 'timeout' };\n  const code = /^\[Exit Code: (-?\d+)\]/.exec(head) ?? /\(exit code: (-?\d+)\)/.exec(head);\n  if (code) {\n    const exitCode = Number(code[1]);\n    return { state: exitCode === 0 ? 'passed' : 'failed', exitCode };\n  }\n  if (row.status === 'error' || isErrorResult(result)) return { state: 'error' };\n  return { state: 'unknown' };",
  ],
]);
edit('src/renderer/src/components/Timeline.tsx', [
  ["      case 'denied':\n        return { text: t.timeline.status.denied, tone: 'muted' };\n      default:", "      case 'denied':\n        return { text: t.timeline.status.denied, tone: 'muted' };\n      case 'unknown':\n        return null;\n      default:"],
]);
edit('scripts/test-timeline.ts', [
  [
    "  check('outcomes of odd shell results', bashOutcome({ status: 'running' }).state === 'running' && bashOutcome({ status: 'done', result: 'Command executed successfully with no output (exit code: 0).' }).state === 'passed' && bashOutcome({ status: 'error', result: 'Error: boom' }).state === 'error' && bashOutcome({ status: 'done', result: 'User denied permission to run the command: \"x\"' }).state === 'denied');",
    "  check('outcomes of odd shell results', bashOutcome({ status: 'running' }).state === 'running' && bashOutcome({ status: 'done', result: 'Command executed successfully with no output (exit code: 0).' }).state === 'passed' && bashOutcome({ status: 'error', result: 'Error: boom' }).state === 'error' && bashOutcome({ status: 'done', result: 'User denied permission to run the command: \"x\"' }).state === 'denied');\n  check('core\'s refusals are not \"passed\": cancelled before approval, no one to ask, destructive and unconfirmed', bashOutcome({ status: 'done', result: 'Cancelled by user before the command was approved: \"echo x\"' }).state === 'cancelled' && bashOutcome({ status: 'done', result: 'Command \"x\" needs the user\'s approval, but no confirmation handler is available.' }).state === 'denied' && bashOutcome({ status: 'done', result: 'Potentially destructive command detected: \"rm -rf x\". Reasons: y, but no confirmation handler is available.' }).state === 'denied');\n  check('an archived output still says how it ended, when its first characters do', bashOutcome({ status: 'done', result: '[Previous tool output archived to save context: [Exit Code: 3]\nstderr...]' }).state === 'failed' && bashOutcome({ status: 'done', result: '[Previous tool output archived to save context: [Exit Code: 0]\nok...]' }).state === 'passed');\n  check('a result that says nothing about how it ended gets no tag, rather than a wrong one', bashOutcome({ status: 'done', result: 'something unexpected' }).state === 'unknown' && bashOutcome({ status: 'done', result: '' }).state === 'unknown' && bashOutcome({ status: 'done', result: '[Previous tool output archived to save context: lots of text...]' }).state === 'unknown');",
  ],
]);
let t = fs.readFileSync('scripts/test-interactions-app.ts', 'utf8');
const a = "  const sessionId = (await ok('sessions.active'))";
t = t.replace("  console.log(`    [diag] card at that moment:", "  void 0; // (diagnostic removed)\n  console.log(`    [diag] card at that moment:");
fs.writeFileSync('scripts/test-interactions-app.ts', t);
console.log('ok');
