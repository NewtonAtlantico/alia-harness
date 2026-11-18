import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { AttachedFile } from '../../core/context/fileMentions.js';
import { renderBanner } from './logo.js';
import { ThinkingAnimation } from './thinking.js';
import { brand, brandLight, danger, muted, success } from './theme.js';
import { SafetyConfirmationContext } from '../../core/safety/safetyChecker.js';
import type { AskUserRequest, UserAnswer, UserQuestion } from '../../core/tools/askUser.js';

interface OutputScope {
  indent: string;
  quiet: boolean;
  label: string;
}

const SCOPE_INDENT = '  ';
const QUIET_ARGS_MAX = 90;

export class TerminalUI {
  /**
   * Nested output scopes (one per running subagent). With none active, every print goes
   * straight to console.log exactly as before, so the parent's output is unchanged.
   */
  private static scopes: OutputScope[] = [];

  /**
   * Starts a nested scope: output is indented under a `│` gutter. `quiet` collapses it to
   * one line per tool call (no reasoning, previews or final message). Always pair with
   * {@link popScope} in a `finally`.
   */
  static pushScope(opts: { label: string; quiet?: boolean }) {
    const depth = TerminalUI.scopes.length + 1;
    TerminalUI.scopes.push({
      indent: SCOPE_INDENT.repeat(depth - 1) + muted('  │ '),
      quiet: opts.quiet ?? false,
      label: opts.label,
    });
  }

  static popScope() {
    TerminalUI.scopes.pop();
  }

  /** Label of the innermost active subagent scope, if any (used to attribute approval prompts). */
  static getScopeLabel(): string | undefined {
    return TerminalUI.scopes.at(-1)?.label;
  }

  private static get scope(): OutputScope | undefined {
    return TerminalUI.scopes.at(-1);
  }

  private static out(text: string) {
    const s = TerminalUI.scope;
    if (!s) {
      console.log(text);
      return;
    }
    console.log(
      text
        .split('\n')
        .map((line) => (line.length > 0 ? s.indent + line : s.indent.trimEnd()))
        .join('\n')
    );
  }

  static printBanner(model: string, vendor: string, endpoint: string) {
    for (const line of renderBanner({ model, vendor, endpoint, cwd: process.cwd() })) {
      console.log(line);
    }
  }

  static printUserPrompt() {
    return pc.bold(brandLight('❯ '));
  }

  /** Starts the animated mascot; call `.stop()` on the result when done. */
  static startThinking(label?: string): ThinkingAnimation {
    // Inside a subagent the cursor-addressed sprite would fight the nested layout: use text.
    return new ThinkingAnimation(label, TerminalUI.scope !== undefined).start();
  }

  static printThinking(reasoning: string) {
    if (TerminalUI.scope?.quiet) return;
    if (reasoning.trim()) {
      TerminalUI.out(pc.dim(pc.italic(`\n💭 [Thinking / Reasoning]:\n${reasoning.trim()}\n`)));
    }
  }

  static clearLine() {
    process.stdout.write('\r\x1b[K');
  }

  static startReasoningBlock() {
    TerminalUI.clearLine();
    console.log(pc.dim(pc.italic('💭 [Thinking / Reasoning]:')));
  }

  static streamReasoningChunk(chunk: string) {
    process.stdout.write(pc.dim(pc.italic(chunk)));
  }

  static endReasoningBlock() {
    console.log('\n');
  }

  static startAssistantBlock() {
    TerminalUI.clearLine();
    console.log(TerminalUI.assistantLabel());
  }

  private static assistantLabel() {
    return pc.bold(brandLight('◆ alia'));
  }

  static streamContentChunk(chunk: string) {
    process.stdout.write(chunk);
  }

  static endAssistantBlock() {
    console.log('\n');
  }

  static printToolCall(toolName: string, argsStr: string) {
    TerminalUI.clearLine();
    let formattedArgs = argsStr;
    try {
      const parsed = JSON.parse(argsStr);
      formattedArgs = Object.entries(parsed)
        .map(([k, v]) => `${pc.dim(k)}=${pc.yellow(JSON.stringify(v))}`)
        .join(' ');
    } catch {
      // Use raw if not valid json yet
    }

    if (TerminalUI.scope?.quiet) {
      // One compact line per step; plain text so truncation can't cut an ANSI sequence.
      const flat = Object.entries(safeParse(argsStr) ?? {})
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(' ') || argsStr;
      const args = flat.length > QUIET_ARGS_MAX ? flat.slice(0, QUIET_ARGS_MAX - 1) + '…' : flat;
      TerminalUI.out(`${brand('●')} ${pc.bold(brandLight(toolName))} ${muted(args)}`);
      return;
    }

    TerminalUI.out(`\n${brand('●')} ${pc.bold(brandLight(toolName))} ${formattedArgs}`);
  }

  static printToolResult(output: string, isError = false) {
    const lines = output.trim().split('\n');

    if (TerminalUI.scope?.quiet) {
      // Successful results are noise at this level; failures are not.
      if (isError) TerminalUI.out(`${danger('✗')} ${danger(lines[0].slice(0, 160))}`);
      return;
    }

    const bar = isError ? danger('│') : muted('│');
    const status = isError ? danger('✗ erro') : success('✓ ok');

    TerminalUI.out(`  ${bar} ${status} ${muted(`(${lines.length} lines)`)}`);

    // Indent tool output for readability
    const previewLines = lines.slice(0, 15);
    for (const line of previewLines) {
      TerminalUI.out(`  ${bar} ` + (isError ? danger(line) : muted(line)));
    }
    if (lines.length > 15) {
      TerminalUI.out(`  ${bar} ${muted(`… and ${lines.length - 15} more lines`)}`);
    }
    TerminalUI.out(muted('  ╰─'));
  }

  static printAssistantMessage(content: string) {
    TerminalUI.clearLine();
    // A quiet subagent's final message goes to its caller, not the screen.
    if (TerminalUI.scope?.quiet) return;
    TerminalUI.out(`\n${TerminalUI.assistantLabel()}`);
    TerminalUI.out(content);
    TerminalUI.out('');
  }

  static printAttachedFiles(attachments: AttachedFile[]) {
    if (attachments.length === 0) return;
    const summary = attachments
      .map((a) => {
        const detail = a.isDir
          ? `${a.lines} entries`
          : `${a.lines} lines${a.truncated ? pc.yellow(', truncated') : ''}`;
        return `${pc.cyan(a.mention)} ${pc.dim(`(${detail})`)}`;
      })
      .join(pc.dim(', '));
    console.log(`${success('📎 Attached:')} ${summary}`);
  }

  static printError(msg: string) {
    TerminalUI.out(danger(`\n✗ Error: ${msg}\n`));
  }

  static printInfo(msg: string) {
    TerminalUI.out(brandLight(`ℹ ${msg}`));
  }

  static printSuccess(msg: string) {
    TerminalUI.out(success(`✔ ${msg}`));
  }
}

function safeParse(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : undefined;
  } catch {
    return undefined;
  }
}

export async function cliConfirmDangerousCommand(ctx: SafetyConfirmationContext): Promise<boolean> {
  console.log('\n' + pc.bgRed(pc.white(' ⚠️  SAFETY GATE: POTENTIALLY DESTRUCTIVE ACTION DETECTED ')));
  const requester = ctx.requester ?? TerminalUI.getScopeLabel();
  if (requester) console.log(pc.magenta(`Requested by subagent: ${requester}`));
  console.log(pc.red(`Command: ${pc.bold(ctx.command)}`));
  console.log(pc.yellow(`Reason(s): ${ctx.reasons.join(', ')}`));
  console.log(pc.cyan('The agent is requesting permission to execute this command on your machine.'));

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(
      pc.bold('Do you want to allow this command? [y/N]: '),
      { signal: ctx.signal }
    );
    const trimmed = answer.trim().toLowerCase();
    return trimmed === 'y' || trimmed === 'yes';
  } catch (err: any) {
    // The run was cancelled while the question was open: dismiss it as a "no".
    if (err?.name === 'AbortError') return false;
    throw err;
  } finally {
    rl.close();
  }
}

const YES = /^(y|yes|s|sim)$/i;
const NO = /^(n|no|nao|não)$/i;

/**
 * Shows the agent's `ask_user` questions in the terminal, one at a time. A choice takes the number
 * of an option (or `d` to defer, when allowed); just pressing Enter skips a question, which then
 * stays open. Input and output are injectable so this can be tested without a TTY.
 */
export async function cliAskUser(
  request: AskUserRequest,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {}
): Promise<UserAnswer[]> {
  const out = io.output ?? output;
  const say = (text = '') => out.write(`${text}\n`);
  const rl = readline.createInterface({ input: io.input ?? input, output: out, terminal: false });

  // Lines are queued as they arrive: readline's question() drops lines that come in while no
  // question is pending, which happens with piped input (several answers in one chunk).
  const queue: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let ended = false;
  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = undefined;
      resolve(line);
    } else queue.push(line);
  });
  // If the input ends while a question is open, that is "no answer", not an endless wait.
  rl.once('close', () => {
    ended = true;
    waiting?.('');
    waiting = undefined;
  });
  const aborted = () => Object.assign(new Error('The question was dismissed.'), { name: 'AbortError' });
  const ask = (query: string): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      out.write(query);
      const next = queue.shift();
      if (next !== undefined) return resolve(next);
      if (ended) return resolve('');
      const signal = request.signal;
      if (signal?.aborted) return reject(aborted());
      const onAbort = () => {
        waiting = undefined;
        reject(aborted());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiting = (line) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(line);
      };
    });

  const answers: UserAnswer[] = [];
  try {
    const n = request.questions.length;
    say(`\n${pc.bold(pc.cyan(`The agent has ${n} question${n === 1 ? '' : 's'} for you.`))} ${pc.dim('(Enter skips a question; it stays open.)')}`);
    for (const [i, q] of request.questions.entries()) {
      const answer = await askOne(q, i + 1, n, ask, say);
      if (answer) answers.push(answer);
    }
  } finally {
    rl.close();
  }
  return answers;
}

async function askOne(
  q: UserQuestion,
  index: number,
  total: number,
  ask: (query: string) => Promise<string>,
  say: (text?: string) => void
): Promise<UserAnswer | undefined> {
  say(`\n${pc.bold(`${index}/${total}`)} ${q.prompt}${q.confidence === 'low' ? pc.dim('  (low confidence)') : ''}`);
  const options = q.options ?? [];
  if (q.kind === 'choice') {
    options.forEach((o, j) => {
      say(`  ${pc.cyan(`${j + 1})`)} ${o.label}`);
      if (o.detail) say(pc.dim(`       ${o.detail}`));
      if (o.source) say(pc.dim(`       source: ${o.source}`));
    });
  }
  const hints = [
    q.kind === 'choice' ? `1-${options.length}${q.allowOther ? ' or type your own' : ''}` : q.kind === 'confirm' ? 'y/n' : 'type your answer',
    ...(q.allowDefer ? ['d = defer as an assumption'] : []),
  ];

  for (let attempt = 0; attempt < 3; attempt++) {
    const raw = (await ask(pc.dim(`(${hints.join(', ')}) `) + pc.bold('› '))).trim();
    if (!raw) return undefined;

    if (q.allowDefer && /^d(efer)?$/i.test(raw)) {
      const owner = (await ask(pc.bold('Owner of this assumption: '))).trim();
      return { id: q.id, deferred: true, owner: owner || undefined };
    }
    if (q.kind === 'text') return { id: q.id, answer: raw };
    if (q.kind === 'confirm') {
      if (YES.test(raw)) return { id: q.id, answer: true };
      if (NO.test(raw)) return { id: q.id, answer: false };
      say(pc.yellow('Please answer y or n.'));
      continue;
    }
    const byNumber = /^\d+$/.test(raw) ? options[Number(raw) - 1] : undefined;
    const byName = options.find((o) => o.id.toLowerCase() === raw.toLowerCase() || o.label.toLowerCase() === raw.toLowerCase());
    const chosen = byNumber ?? byName;
    if (chosen) return { id: q.id, answer: chosen.id };
    if (q.allowOther) return { id: q.id, answer: raw };
    say(pc.yellow(`Please choose a number from 1 to ${options.length}.`));
  }
  return undefined; // not understood after three tries: leave it open
}

/** Audit line shown when `--auto-approve` lets a destructive command through. */
export function cliAutoApproveNotice(command: string): void {
  console.log(pc.yellow(`⚠️  [Auto-Approved Dangerous Command]: ${command}`));
}
