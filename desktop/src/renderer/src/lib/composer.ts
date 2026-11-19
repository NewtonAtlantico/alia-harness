/**
 * The composer's text logic, with no React and no DOM: finding the `@mention` or `/command` at the caret, putting the
 * chosen entry back into the text, and the shell-style input history. Quoting follows the core's mention syntax:
 * `@src/app.ts`, and `@"Proposta Técnica 2026.pdf"` when the path has spaces.
 */
import type { CommandInfo, WorkspaceEntry } from '../../../shared/ipc';

export interface ActiveMention {
  /** Index of the `@`. */
  start: number;
  /** Where the text being replaced ends (the caret). */
  end: number;
  /** What the user typed after the `@` (and after the opening quote, if any). */
  query: string;
  /** The mention was opened with a quote, so it may hold spaces. */
  quoted: boolean;
}

/** The `@mention` the caret is in, or undefined. An `@` counts only at the start of a word (so `ana@host` is not one). */
export function activeMention(text: string, caret: number): ActiveMention | undefined {
  const before = text.slice(0, caret);
  // Look back for the nearest "@" that starts a word, without crossing a newline.
  for (let i = before.length - 1; i >= 0; i--) {
    const ch = before[i];
    if (ch === '\n' || ch === '\r') return undefined;
    if (ch !== '@') continue;
    if (i > 0 && !/\s/.test(before[i - 1])) continue; // "user@host": keep looking back
    const rest = before.slice(i + 1);
    if (rest.startsWith('"')) {
      const body = rest.slice(1);
      if (body.includes('"')) return undefined; // the quote was closed: the mention is complete
      return { start: i, end: caret, query: body, quoted: true };
    }
    if (/[\s@]/.test(rest)) return undefined; // a space ends an unquoted mention
    return { start: i, end: caret, query: rest, quoted: false };
  }
  return undefined;
}

/** A path as the core reads it in a mention: quoted when it has whitespace. */
export function quoteIfNeeded(p: string): string {
  return /\s/.test(p) ? `"${p}"` : p;
}

/**
 * What a chosen entry turns the typed mention into.
 *  - `complete`: the whole thing, followed by a space (a folder keeps its trailing slash: the "pasta inteira" case);
 *  - `drill`: a folder, left open so its contents show next (Tab); for a file it is the same as `complete`.
 */
export function applyMention(text: string, mention: ActiveMention, entry: Pick<WorkspaceEntry, 'path' | 'isDir'>, how: 'complete' | 'drill'): { text: string; caret: number } {
  const path = entry.isDir ? `${entry.path.replace(/\/+$/, '')}/` : entry.path;
  const spaced = /\s/.test(path);
  let insert: string;
  if (entry.isDir && how === 'drill') insert = spaced ? `@"${path}` : `@${path}`; // left open: the menu continues inside it
  else insert = (spaced ? `@"${path}"` : `@${path}`) + ' ';
  const next = text.slice(0, mention.start) + insert + text.slice(mention.end);
  return { text: next, caret: mention.start + insert.length };
}

export interface ActiveSlash {
  query: string;
  /** The end of the first word (what a chosen command replaces). */
  end: number;
}

/** The `/command` being typed: only the first word of the message, and only while the caret is still in it. */
export function activeSlash(text: string, caret: number): ActiveSlash | undefined {
  if (!text.startsWith('/')) return undefined;
  const space = text.search(/\s/);
  const end = space === -1 ? text.length : space;
  if (caret > end) return undefined;
  return { query: text.slice(1, end), end };
}

/** Commands whose name starts with what was typed (all of them for a bare "/"); if none does, those that contain it. */
export function filterCommands(commands: CommandInfo[], query: string): CommandInfo[] {
  const q = query.toLowerCase();
  const starts = commands.filter((c) => c.name.toLowerCase().startsWith(q));
  // Typing narrows the list; the closest name first (/mo gives /model before /models). A bare slash keeps the registry order.
  if (q !== '') starts.sort((a, b) => a.name.length - b.name.length);
  return starts.length > 0 || q === '' ? starts : commands.filter((c) => c.name.toLowerCase().includes(q));
}

/** Puts a chosen command at the start, keeping whatever was typed after it. */
export function applyCommand(text: string, slash: ActiveSlash, command: Pick<CommandInfo, 'name' | 'acceptsArgs'>): { text: string; caret: number } {
  const rest = text.slice(slash.end).replace(/^\s+/, '');
  const head = `/${command.name}${command.acceptsArgs || rest ? ' ' : ''}`;
  return { text: head + rest, caret: head.length };
}

/** `/model gpt-oss` is the command "model" with the argument "gpt-oss". Not a command: undefined. */
export function parseSlash(text: string): { name: string; arg: string } | undefined {
  const m = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? '').trim() } : undefined;
}

/** Appends `@mentions` for attached files to a message, quoting paths with spaces. */
export function withAttachments(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  const mentions = paths.map((p) => `@${/\s/.test(p) ? `"${p}"` : p}`).join(' ');
  return text.trim() ? `${text.trimEnd()}\n${mentions}` : mentions;
}

/**
 * Shell-style history of what was sent: Up goes to older entries, Down back to newer ones and finally to what was being
 * typed. Repeats in a row are kept once; the list is capped.
 */
export class InputHistory {
  private items: string[];
  private cursor: number; // items.length means "the draft"
  private draft = '';

  constructor(
    initial: string[] = [],
    private readonly max = 50
  ) {
    this.items = initial.slice(-max);
    this.cursor = this.items.length;
  }

  get entries(): readonly string[] {
    return this.items;
  }

  push(text: string): void {
    const t = text.trim();
    if (t && this.items.at(-1) !== t) this.items.push(t);
    if (this.items.length > this.max) this.items.splice(0, this.items.length - this.max);
    this.reset();
  }

  /** The next older entry, remembering `current` as the draft the first time. Undefined at the oldest. */
  prev(current: string): string | undefined {
    if (this.items.length === 0 || this.cursor === 0) return undefined;
    if (this.cursor === this.items.length) this.draft = current;
    this.cursor--;
    return this.items[this.cursor];
  }

  /** The next newer entry, or the draft after the newest. Undefined when not browsing. */
  next(): string | undefined {
    if (this.cursor >= this.items.length) return undefined;
    this.cursor++;
    return this.cursor === this.items.length ? this.draft : this.items[this.cursor];
  }

  /** Stop browsing (the user typed something, or sent). */
  reset(): void {
    this.cursor = this.items.length;
    this.draft = '';
  }

  get browsing(): boolean {
    return this.cursor < this.items.length;
  }
}
