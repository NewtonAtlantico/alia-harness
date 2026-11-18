import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';
import { AttachedFile } from '../../core/context/fileMentions.js';
import { renderBanner } from './logo.js';
import { ThinkingAnimation } from './thinking.js';
import { brand, brandLight, danger, muted, success } from './theme.js';
import { SafetyConfirmationContext } from '../../core/safety/safetyChecker.js';

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

/** Audit line shown when `--auto-approve` lets a destructive command through. */
export function cliAutoApproveNotice(command: string): void {
  console.log(pc.yellow(`⚠️  [Auto-Approved Dangerous Command]: ${command}`));
}
