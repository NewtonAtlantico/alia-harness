import pc from 'picocolors';
import { AttachedFile } from '../context/fileMentions.js';

export class TerminalUI {
  static printBanner(model: string, vendor: string, endpoint: string) {
    const border = '═'.repeat(68);
    console.log(pc.cyan(`╔${border}╗`));
    console.log(
      pc.cyan('║') +
        pc.bold(pc.magenta('                 ALIA HARNESS - AI AGENT CLI                        ')) +
        pc.cyan('║')
    );
    console.log(
      pc.cyan('║') +
        pc.dim('  Autonomous coding agent powered by OpenAI-compatible Alia models  ') +
        pc.cyan('║')
    );
    console.log(pc.cyan(`╠${border}╣`));
    console.log(
      pc.cyan('║') +
        ` ${pc.bold('Vendor:')}   ${pc.yellow(vendor.padEnd(20))} ${pc.bold('Model:')} ${pc.green(model.padEnd(28))} ` +
        pc.cyan('║')
    );
    console.log(
      pc.cyan('║') +
        ` ${pc.bold('Endpoint:')} ${pc.dim(endpoint.padEnd(55).slice(0, 55))} ` +
        pc.cyan('║')
    );
    console.log(pc.cyan(`╚${border}╝`));
    console.log(
      pc.dim('Type your prompt, mention files with @ for live preview, or use slash commands (/help)\n')
    );
  }

  static printUserPrompt() {
    return pc.bold(pc.green('user > '));
  }

  static printThinkingStatus() {
    process.stdout.write(pc.dim('🤔 Thinking...\r'));
  }

  static printThinking(reasoning?: string) {
    if (reasoning && reasoning.trim()) {
      console.log(pc.dim(pc.italic(`\n💭 [Thinking / Reasoning]:\n${reasoning.trim()}\n`)));
    } else {
      process.stdout.write(pc.dim('🤔 Thinking...\r'));
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
    console.log(pc.bold(pc.magenta('🤖 Assistant:')));
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

    console.log(
      `\n${pc.bgBlue(pc.white(' 🔧 TOOL '))} ${pc.bold(pc.cyan(toolName))} ${formattedArgs}`
    );
  }

  static printToolResult(output: string, isError = false) {
    const lines = output.trim().split('\n');
    const badge = isError
      ? pc.bgRed(pc.white(' ❌ RESULT '))
      : pc.bgGreen(pc.black(' ✓ RESULT '));

    console.log(`${badge} ${pc.dim(`(${lines.length} lines)`)}`);

    // Indent tool output for readability
    const previewLines = lines.slice(0, 15);
    for (const line of previewLines) {
      console.log(pc.dim('  │ ') + (isError ? pc.red(line) : pc.white(line)));
    }
    if (lines.length > 15) {
      console.log(pc.dim(`  │ ... and ${lines.length - 15} more lines`));
    }
    console.log(pc.dim('  └───'));
  }

  static printAssistantMessage(content: string) {
    TerminalUI.clearLine();
    console.log(`\n${pc.bold(pc.magenta('🤖 Assistant:'))}`);
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
    console.log(`${pc.green('📎 Attached:')} ${summary}`);
  }

  static printError(msg: string) {
    console.log(pc.red(`\n❌ Error: ${msg}\n`));
  }

  static printInfo(msg: string) {
    console.log(pc.cyan(`ℹ️  ${msg}`));
  }

  static printSuccess(msg: string) {
    console.log(pc.green(`✔ ${msg}`));
  }
}
