import readline from 'node:readline';
import pc from 'picocolors';

export interface SlashCommandInfo {
  command: string;
  description: string;
  usage?: string;
}

export const SLASH_COMMANDS: SlashCommandInfo[] = [
  { command: '/help', description: 'Show available slash commands and usage' },
  { command: '/tools', description: 'List all available tools and parameters' },
  { command: '/models', description: 'List models from config and remote endpoint' },
  { command: '/model', description: 'Switch active model (e.g. /model gpt-oss:20b)', usage: '/model <id>' },
  { command: '/clear', description: 'Reset conversation history' },
  { command: '/tokens', description: 'Show estimated context tokens used' },
  { command: '/exit', description: 'Exit the agent harness' },
  { command: '/quit', description: 'Exit the agent harness' },
];

function visibleLength(str: string): number {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
}

export class DynamicPrompt {
  private history: string[] = [];
  private historyIndex = -1;
  private savedBuffer = '';
  private promptPrefix = pc.bold(pc.green('user > '));
  private promptPrefixLen = 7;
  private lastPreviewLines = 0;

  constructor(promptPrefix?: string) {
    if (promptPrefix) {
      this.promptPrefix = promptPrefix;
      this.promptPrefixLen = visibleLength(promptPrefix);
    }
  }

  /**
   * Prompts the user for input.
   * If running in an interactive TTY, provides dynamic slash-command preview on typing '/'.
   * Otherwise falls back to standard line reading.
   */
  async ask(): Promise<string> {
    if (!process.stdin.isTTY) {
      return this.askFallback();
    }
    return this.askInteractive();
  }

  private askFallback(): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.question(this.promptPrefix, (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  private askInteractive(): Promise<string> {
    return new Promise((resolve) => {
      let buffer = '';
      let cursorPos = 0;
      let selectedIndex = 0;
      let hasNavigated = false;
      this.historyIndex = this.history.length;
      this.savedBuffer = '';
      this.lastPreviewLines = 0;

      const wasRaw = process.stdin.isRaw;
      process.stdin.setRawMode(true);
      process.stdin.resume();
      readline.emitKeypressEvents(process.stdin);

      const cleanup = () => {
        process.stdin.removeListener('keypress', onKeypress);
        if (process.stdin.setRawMode) {
          process.stdin.setRawMode(wasRaw || false);
        }
      };

      const clearPreview = () => {
        if (this.lastPreviewLines > 0) {
          for (let i = 0; i < this.lastPreviewLines; i++) {
            process.stdout.write('\n\x1b[2K');
          }
          process.stdout.write(`\x1b[${this.lastPreviewLines}A`);
          this.lastPreviewLines = 0;
        }
      };

      const render = () => {
        // 1. Clear previous preview lines if any
        clearPreview();

        // 2. Redraw current prompt line
        process.stdout.write(`\r\x1b[2K${this.promptPrefix}${buffer}`);

        // 3. Render dynamic preview if input starts with '/'
        let previewLines: string[] = [];
        if (buffer.startsWith('/')) {
          const typedCmd = buffer.split(' ')[0].toLowerCase();
          const matches = SLASH_COMMANDS.filter((c) =>
            c.command.toLowerCase().startsWith(typedCmd)
          );

          selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, matches.length - 1)));
          previewLines = this.buildPreviewBox(matches, selectedIndex);

          for (const line of previewLines) {
            process.stdout.write('\n\x1b[2K' + line);
          }

          if (previewLines.length > 0) {
            process.stdout.write(`\x1b[${previewLines.length}A`);
            this.lastPreviewLines = previewLines.length;
          }
        }

        // 4. Position cursor at the user's active cursor location
        const targetCol = this.promptPrefixLen + cursorPos + 1;
        process.stdout.write(`\x1b[${targetCol}G`);
      };

      const onKeypress = (str: string, key: readline.Key) => {
        if (!key) {
          if (str) {
            buffer = buffer.slice(0, cursorPos) + str + buffer.slice(cursorPos);
            cursorPos += str.length;
            selectedIndex = 0;
            hasNavigated = false;
            render();
          }
          return;
        }

        // Ctrl+C handling
        if (key.ctrl && key.name === 'c') {
          clearPreview();
          if (buffer.length > 0) {
            buffer = '';
            cursorPos = 0;
            selectedIndex = 0;
            hasNavigated = false;
            render();
            return;
          }
          process.stdout.write('\n');
          cleanup();
          process.exit(0);
        }

        // Enter / Return handling
        if (key.name === 'return' || key.name === 'enter') {
          clearPreview();
          process.stdout.write('\n');

          let finalInput = buffer.trim();

          // If user navigated with arrows inside the preview menu, select that command
          if (buffer.startsWith('/') && hasNavigated) {
            const typedCmd = buffer.split(' ')[0].toLowerCase();
            const matches = SLASH_COMMANDS.filter((c) =>
              c.command.toLowerCase().startsWith(typedCmd)
            );
            if (matches[selectedIndex]) {
              const chosen = matches[selectedIndex];
              if (chosen.command === '/model' && !buffer.includes(' ')) {
                // If /model chosen, prompt them to specify model
                buffer = '/model ';
                cursorPos = buffer.length;
                hasNavigated = false;
                render();
                return;
              }
              finalInput = chosen.command;
            }
          }

          if (finalInput) {
            this.history.push(finalInput);
          }

          cleanup();
          resolve(finalInput);
          return;
        }

        // Tab Autocomplete
        if (key.name === 'tab') {
          if (buffer.startsWith('/')) {
            const typedCmd = buffer.split(' ')[0].toLowerCase();
            const matches = SLASH_COMMANDS.filter((c) =>
              c.command.toLowerCase().startsWith(typedCmd)
            );

            if (matches.length > 0) {
              const chosen = matches[selectedIndex] || matches[0];
              buffer = chosen.command + ' ';
              cursorPos = buffer.length;
              selectedIndex = 0;
              hasNavigated = false;
              render();
            }
          }
          return;
        }

        // Backspace
        if (key.name === 'backspace') {
          if (cursorPos > 0) {
            buffer = buffer.slice(0, cursorPos - 1) + buffer.slice(cursorPos);
            cursorPos--;
            selectedIndex = 0;
            hasNavigated = false;
            render();
          }
          return;
        }

        // Delete key
        if (key.name === 'delete') {
          if (cursorPos < buffer.length) {
            buffer = buffer.slice(0, cursorPos) + buffer.slice(cursorPos + 1);
            render();
          }
          return;
        }

        // Arrow Left
        if (key.name === 'left') {
          if (cursorPos > 0) {
            cursorPos--;
            render();
          }
          return;
        }

        // Arrow Right
        if (key.name === 'right') {
          if (cursorPos < buffer.length) {
            cursorPos++;
            render();
          }
          return;
        }

        // Home / End
        if (key.name === 'home') {
          cursorPos = 0;
          render();
          return;
        }
        if (key.name === 'end') {
          cursorPos = buffer.length;
          render();
          return;
        }

        // Arrow Up
        if (key.name === 'up') {
          if (buffer.startsWith('/')) {
            // Navigate slash command preview
            const typedCmd = buffer.split(' ')[0].toLowerCase();
            const matches = SLASH_COMMANDS.filter((c) =>
              c.command.toLowerCase().startsWith(typedCmd)
            );
            if (matches.length > 0) {
              selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
              hasNavigated = true;
              render();
            }
          } else {
            // Navigate prompt history
            if (this.history.length > 0) {
              if (this.historyIndex === this.history.length) {
                this.savedBuffer = buffer;
              }
              if (this.historyIndex > 0) {
                this.historyIndex--;
                buffer = this.history[this.historyIndex];
                cursorPos = buffer.length;
                render();
              }
            }
          }
          return;
        }

        // Arrow Down
        if (key.name === 'down') {
          if (buffer.startsWith('/')) {
            // Navigate slash command preview
            const typedCmd = buffer.split(' ')[0].toLowerCase();
            const matches = SLASH_COMMANDS.filter((c) =>
              c.command.toLowerCase().startsWith(typedCmd)
            );
            if (matches.length > 0) {
              selectedIndex = (selectedIndex + 1) % matches.length;
              hasNavigated = true;
              render();
            }
          } else {
            // Navigate prompt history
            if (this.historyIndex < this.history.length - 1) {
              this.historyIndex++;
              buffer = this.history[this.historyIndex];
              cursorPos = buffer.length;
              render();
            } else if (this.historyIndex === this.history.length - 1) {
              this.historyIndex++;
              buffer = this.savedBuffer;
              cursorPos = buffer.length;
              render();
            }
          }
          return;
        }

        // Printable text characters
        if (str && !key.ctrl && !key.meta) {
          buffer = buffer.slice(0, cursorPos) + str + buffer.slice(cursorPos);
          cursorPos += str.length;
          selectedIndex = 0;
          hasNavigated = false;
          render();
        }
      };

      process.stdin.on('keypress', onKeypress);
      render();
    });
  }

  private buildPreviewBox(matches: SlashCommandInfo[], selectedIndex: number): string[] {
    const boxWidth = 68;
    const lines: string[] = [];

    // Header
    const title = pc.bold(pc.white(' Slash Commands '));
    const padCount = Math.max(0, boxWidth - 19 - 2);
    lines.push(pc.cyan('  ┌─') + title + pc.cyan('─'.repeat(padCount) + '┐'));

    if (matches.length === 0) {
      const msg = '   No matching commands found. Type /help to see all commands.';
      const rightPad = Math.max(0, boxWidth - msg.length - 4);
      lines.push(
        pc.cyan('  │') +
          pc.yellow(msg) +
          ' '.repeat(rightPad) +
          pc.cyan('│')
      );
    } else {
      for (let i = 0; i < matches.length; i++) {
        const item = matches[i];
        const isSelected = i === selectedIndex;

        const pointer = isSelected ? pc.cyan(pc.bold('❯ ')) : '  ';
        const cmdName = isSelected
          ? pc.bold(pc.yellow(item.command.padEnd(14)))
          : pc.cyan(item.command.padEnd(14));
        const desc = isSelected ? pc.bold(pc.white(item.description)) : pc.dim(item.description);

        // Calculate visible string length to pad to boxWidth
        const rawContent = `  │ ${isSelected ? '❯ ' : '  '}${item.command.padEnd(14)} ${item.description}`;
        const rawLen = rawContent.length;
        const rightPad = Math.max(0, boxWidth - rawLen - 1);

        lines.push(
          pc.cyan('  │ ') +
            pointer +
            cmdName +
            ' ' +
            desc +
            ' '.repeat(rightPad) +
            pc.cyan('│')
        );
      }
    }

    // Footer with navigation hints
    const hint = pc.dim(' [Tab: complete, ↑/↓: navigate, Enter: select] ');
    const hintLen = 46;
    const footerPad = Math.max(0, boxWidth - hintLen - 4);
    lines.push(pc.cyan('  └─') + hint + pc.cyan('─'.repeat(footerPad) + '┘'));

    return lines;
  }
}
