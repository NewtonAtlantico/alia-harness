import readline from 'node:readline';
import pc from 'picocolors';
import { FileIndex, WorkspaceEntry, FILE_PREVIEW_LIMIT } from './fileIndex.js';

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

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Details about the `@query` the cursor is currently inside of. */
interface ActiveMention {
  /** Identity of this mention instance (changes when the user edits it). */
  key: string;
  /** Index of the `@` character in the input buffer. */
  startIndex: number;
  /** Characters typed after the `@` up to the cursor (no whitespace allowed). */
  query: string;
}

export class DynamicPrompt {
  private history: string[] = [];
  private historyIndex = -1;
  private savedBuffer = '';
  private promptPrefix = pc.bold(pc.green('user > '));
  private promptPrefixLen = 7;
  private lastPreviewLines = 0;
  private fileIndex?: FileIndex;

  constructor(promptPrefix?: string, fileIndex?: FileIndex) {
    if (promptPrefix) {
      this.promptPrefix = promptPrefix;
      this.promptPrefixLen = visibleLength(promptPrefix);
    }
    this.fileIndex = fileIndex;
  }

  /**
   * Prompts the user for input.
   * If running in an interactive TTY, provides:
   *   - dynamic slash-command preview on typing '/'
   *   - dynamic file-mention preview on typing '@' (when a FileIndex is provided)
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
      let menuSuppressed = false;
      let lastMentionKey = '';
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

      /**
       * Detects the @-mention the cursor is currently composing, if any.
       * A mention is active when '@' starts a new word (start of input or
       * preceded by whitespace/punctuation) and no whitespace has been typed
       * since. Slash-command mode takes precedence.
       */
      const getActiveMention = (): ActiveMention | null => {
        if (!this.fileIndex || buffer.startsWith('/')) return null;
        if (cursorPos === 0) return null;

        const before = buffer.slice(0, cursorPos);
        const at = before.lastIndexOf('@');
        if (at === -1) return null;
        if (at > 0 && /[\w@]/.test(before[at - 1])) return null; // emails, code refs, '@@'

        const query = before.slice(at + 1);
        if (/\s/.test(query)) return null; // mention already closed with whitespace

        return { key: `${at}:${query}`, startIndex: at, query };
      };

      /**
       * Returns the active mention when the file preview menu should be
       * visible for it, syncing per-mention UI state (dismissal, selection).
       */
      const getMenuMention = (): ActiveMention | null => {
        const mention = getActiveMention();
        if (!mention) return null;

        if (mention.key !== lastMentionKey) {
          lastMentionKey = mention.key;
          menuSuppressed = false;
          selectedIndex = 0;
        }
        if (menuSuppressed) return null;
        // Once a mention is a complete known file path, the menu has served
        // its purpose — hide it until the user edits the mention again.
        if (this.fileIndex!.exactFileMatch(mention.query)) return null;

        return mention;
      };

      /** Current ranked matches for a mention, with selection clamped. */
      const getMentionMatches = (mention: ActiveMention) => {
        const result = this.fileIndex!.search(mention.query, FILE_PREVIEW_LIMIT);
        selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, result.matches.length - 1)));
        return result;
      };

      /** Replaces the typed `@query` with the chosen `@path` (plus trailing space or slash). */
      const insertMention = (entry: WorkspaceEntry) => {
        const mention = getActiveMention();
        if (!mention) return;

        const insertText = '@' + entry.path + (entry.isDir ? '/' : ' ');
        buffer = buffer.slice(0, mention.startIndex) + insertText + buffer.slice(cursorPos);
        cursorPos = mention.startIndex + insertText.length;
        selectedIndex = 0;
        hasNavigated = false;
        render();
      };

      const render = () => {
        // 1. Clear previous preview lines if any
        clearPreview();

        // 2. Redraw current prompt line
        process.stdout.write(`\r\x1b[2K${this.promptPrefix}${buffer}`);

        // 3. Render dynamic preview (slash commands or file mentions)
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
        } else {
          const mention = getMenuMention();
          if (mention) {
            const { matches, total } = getMentionMatches(mention);
            previewLines = this.buildFilePreviewBox(matches, selectedIndex, total);

            for (const line of previewLines) {
              process.stdout.write('\n\x1b[2K' + line);
            }

            if (previewLines.length > 0) {
              process.stdout.write(`\x1b[${previewLines.length}A`);
              this.lastPreviewLines = previewLines.length;
            }
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
          // If the user highlighted a file with arrows inside the @-menu,
          // Enter confirms the insertion instead of submitting.
          const mention = getMenuMention();
          if (mention && hasNavigated) {
            const { matches } = getMentionMatches(mention);
            if (matches[selectedIndex]) {
              insertMention(matches[selectedIndex]);
              return;
            }
          }

          clearPreview();
          process.stdout.write('\n');

          let finalInput = buffer.trim();

          // If user navigated with arrows inside the slash preview, select that command
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

        // Tab Autocomplete (slash commands or file mentions)
        if (key.name === 'tab') {
          const mention = getMenuMention();
          if (mention) {
            const { matches } = getMentionMatches(mention);
            if (matches.length > 0) {
              insertMention(matches[selectedIndex] || matches[0]);
            }
            return;
          }

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

        // Escape: dismiss the file-mention preview until the mention changes
        if (key.name === 'escape') {
          const mention = getMenuMention();
          if (mention) {
            menuSuppressed = true;
            render();
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
          const mention = getMenuMention();
          if (mention) {
            // Navigate file-mention preview
            const { matches } = getMentionMatches(mention);
            if (matches.length > 0) {
              selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
              hasNavigated = true;
              render();
            }
            return;
          }

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
          const mention = getMenuMention();
          if (mention) {
            // Navigate file-mention preview
            const { matches } = getMentionMatches(mention);
            if (matches.length > 0) {
              selectedIndex = (selectedIndex + 1) % matches.length;
              hasNavigated = true;
              render();
            }
            return;
          }

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

  private buildFilePreviewBox(
    matches: WorkspaceEntry[],
    selectedIndex: number,
    total: number
  ): string[] {
    const boxWidth = 68;
    const pathColWidth = 36;
    const infoColWidth = 10;
    const lines: string[] = [];

    // Header
    const title = pc.bold(pc.white(' Files '));
    const padCount = Math.max(0, boxWidth - 4 - visibleLength(title) - 1);
    lines.push(pc.cyan('  ┌─') + title + pc.cyan('─'.repeat(padCount) + '┐'));

    if (matches.length === 0) {
      const msg = ' No matching files. Keep typing to search the workspace.';
      // visible width: 4 ("  │ ") + msg + pad + 1 (space) + 1 ("│") = boxWidth
      const rightPad = Math.max(0, boxWidth - msg.length - 6);
      lines.push(
        pc.cyan('  │ ') + pc.yellow(msg) + ' '.repeat(rightPad) + pc.cyan(' │')
      );
    } else {
      for (let i = 0; i < matches.length; i++) {
        const entry = matches[i];
        const isSelected = i === selectedIndex;

        const label = entry.isDir ? entry.path + '/' : entry.path;
        const displayPath =
          label.length > pathColWidth
            ? '…' + label.slice(label.length - pathColWidth + 1)
            : label;

        const rawInfo = entry.isDir ? `${entry.childCount} items` : humanSize(entry.size);
        const info =
          rawInfo.length > infoColWidth ? rawInfo.slice(0, infoColWidth - 1) + '…' : rawInfo;

        const pointer = isSelected ? pc.cyan(pc.bold('❯ ')) : '  ';
        // Pad plain text first, then colorize, so ANSI escapes don't skew widths
        const paddedPath = displayPath.padEnd(pathColWidth);
        const paddedInfo = info.padStart(infoColWidth);
        const pathText = isSelected ? pc.bold(pc.yellow(paddedPath)) : pc.cyan(paddedPath);
        const infoText = isSelected ? pc.bold(pc.white(paddedInfo)) : pc.dim(paddedInfo);

        // visible width: 4 ("  │ ") + 2 (pointer) + 36 (path) + 1 (space) + 10 (info) + pad + 1 ("│")
        const rightPad = Math.max(1, boxWidth - 4 - 2 - pathColWidth - 1 - infoColWidth - 1);

        lines.push(
          pc.cyan('  │ ') +
            pointer +
            pathText +
            ' ' +
            infoText +
            ' '.repeat(rightPad) +
            pc.cyan('│')
        );
      }

      // Overflow indicator when more matches exist than displayed
      if (total > matches.length) {
        const msg = ` … and ${total - matches.length} more matches (keep typing to filter)`;
        const rightPad = Math.max(0, boxWidth - msg.length - 6);
        lines.push(
          pc.cyan('  │ ') + pc.dim(msg) + ' '.repeat(rightPad) + pc.cyan(' │')
        );
      }
    }

    // Footer with navigation hints
    const hint = pc.dim(' [Tab: insert, ↑/↓: navigate, Enter: confirm, Esc: dismiss] ');
    const footerPad = Math.max(0, boxWidth - visibleLength(hint) - 5);
    lines.push(pc.cyan('  └─') + hint + pc.cyan('─'.repeat(footerPad) + '┘'));

    return lines;
  }
}
