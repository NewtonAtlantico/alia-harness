import pc from 'picocolors';
import { AttachedFile } from '../context/fileMentions.js';
import { renderBanner } from './logo.js';
import { ThinkingAnimation } from './thinking.js';
import { brand, brandLight, danger, muted, success } from './theme.js';

export class TerminalUI {
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
    return new ThinkingAnimation(label).start();
  }

  static printThinking(reasoning: string) {
    if (reasoning.trim()) {
      console.log(pc.dim(pc.italic(`\n💭 [Thinking / Reasoning]:\n${reasoning.trim()}\n`)));
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

    console.log(`\n${brand('●')} ${pc.bold(brandLight(toolName))} ${formattedArgs}`);
  }

  static printToolResult(output: string, isError = false) {
    const lines = output.trim().split('\n');
    const bar = isError ? danger('│') : muted('│');
    const status = isError ? danger('✗ erro') : success('✓ ok');

    console.log(`  ${bar} ${status} ${muted(`(${lines.length} lines)`)}`);

    // Indent tool output for readability
    const previewLines = lines.slice(0, 15);
    for (const line of previewLines) {
      console.log(`  ${bar} ` + (isError ? danger(line) : muted(line)));
    }
    if (lines.length > 15) {
      console.log(`  ${bar} ${muted(`… and ${lines.length - 15} more lines`)}`);
    }
    console.log(muted('  ╰─'));
  }

  static printAssistantMessage(content: string) {
    TerminalUI.clearLine();
    console.log(`\n${TerminalUI.assistantLabel()}`);
    console.log(content);
    console.log();
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
    console.log(danger(`\n✗ Error: ${msg}\n`));
  }

  static printInfo(msg: string) {
    console.log(brandLight(`ℹ ${msg}`));
  }

  static printSuccess(msg: string) {
    console.log(success(`✔ ${msg}`));
  }
}
