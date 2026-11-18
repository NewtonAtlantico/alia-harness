import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { projectFolderName, sameWorkspace } from '../projectKey.js';

/**
 * Saved conversations, for the sidebar's Recents, search and resume.
 *
 * Layout (outside the project, so conversation content is never committed with a repo):
 *   ~/.alia/sessions/<project>-<hash>/<id>.jsonl       the history, one JSON entry per line
 *   ~/.alia/sessions/<project>-<hash>/<id>.meta.json   title, workspace, model, createdAt
 *
 * The history is the OpenAI-format `messages` array, stored as it is in memory, so a resumed
 * session sends the model exactly what it saw before (pinned skill blocks and archived tool
 * output included). Entries are appended; the three kinds cover every way the history changes:
 *   {"t":"msg","m":<message>}            a message was added
 *   {"t":"set","i":<index>,"m":<msg>}    an older message was rewritten (tool output archived)
 *   {"t":"replace","messages":[...]}     the history was cleared or replaced (/clear, /compact)
 */

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export interface SessionInfo {
  id: string;
  title: string;
  /** `auto` until the user renames the session; an auto title never overwrites a chosen one. */
  titleSource: 'auto' | 'user';
  workspace: string;
  model: string;
  createdAt: string;
  /** Last time the conversation changed. */
  updatedAt: string;
}

export interface LoadedSession {
  info: SessionInfo;
  messages: ChatMessage[];
  /** Lines that could not be read (a write cut short by a crash, or damage). They are ignored. */
  skipped: number;
}

export interface SearchMatch {
  where: 'title' | 'user' | 'assistant';
  /** The matching text with some surrounding context. */
  snippet: string;
}

export interface SearchHit {
  info: SessionInfo;
  matches: SearchMatch[];
}

export interface SessionStoreOptions {
  /** Root folder. Default `~/.alia/sessions`. */
  dir?: string;
}

interface MetaFile {
  version: 1;
  id: string;
  title: string;
  titleSource: 'auto' | 'user';
  workspace: string;
  model: string;
  createdAt: string;
}

type Entry =
  | { t: 'msg'; m: ChatMessage }
  | { t: 'set'; i: number; m: ChatMessage }
  | { t: 'replace'; messages: ChatMessage[] };

const ID_PATTERN = /^[\w.-]+$/;
const MAX_TITLE = 60;
const FALLBACK_TITLE = 'New conversation';

function assertId(id: string): void {
  if (!ID_PATTERN.test(id) || id === '.' || id === '..') throw new Error(`Invalid session id: "${id}"`);
}

/** Sortable and readable: 20261118-143005-a1b2c3. */
export function newSessionId(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `${stamp}-${crypto.randomBytes(3).toString('hex')}`;
}

/** Text of a message (string content, or the text parts of a multi-part one). */
export function messageText(message: ChatMessage): string {
  const c = (message as any).content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (p?.type === 'text' ? p.text : '')).join('\n');
  return '';
}

/** Skill playbooks pinned in a user message are long and say nothing about what the user asked. */
const SKILL_BLOCK = /<skill [\s\S]*?<\/skill>/g;
const searchableText = (message: ChatMessage) => messageText(message).replace(SKILL_BLOCK, ' ');

/**
 * A short title from the first user message. A `/skill` invocation becomes `/skill-name input`
 * instead of the skill's boilerplate.
 */
export function deriveTitle(text: string): string {
  let source = text;
  const skill = /^I invoked the "([^"]+)" skill/.exec(text);
  if (skill) {
    const idx = text.lastIndexOf('Request / input:');
    const input = idx >= 0 ? text.slice(idx + 'Request / input:'.length).trim() : '';
    source = input && !input.startsWith('(none given') ? `/${skill[1]} ${input}` : `/${skill[1]}`;
  }
  const line = source.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? '';
  const flat = line.replace(/\s+/g, ' ');
  if (!flat) return FALLBACK_TITLE;
  if (flat.length <= MAX_TITLE) return flat;
  const cut = flat.slice(0, MAX_TITLE - 1);
  const space = cut.lastIndexOf(' ');
  return (space > MAX_TITLE / 2 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

function readEntries(file: string): { entries: Entry[]; skipped: number } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries: Entry[] = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (e?.t === 'msg' && e.m && typeof e.m.role === 'string') entries.push(e);
      else if (e?.t === 'set' && Number.isInteger(e.i) && e.i >= 0 && e.m && typeof e.m.role === 'string') entries.push(e);
      else if (e?.t === 'replace' && Array.isArray(e.messages)) entries.push(e);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { entries, skipped };
}

function applyEntries(entries: Entry[]): ChatMessage[] {
  let messages: ChatMessage[] = [];
  for (const e of entries) {
    if (e.t === 'msg') messages.push(e.m);
    else if (e.t === 'set') {
      if (e.i < messages.length) messages[e.i] = e.m;
    } else messages = [...e.messages];
  }
  return messages;
}

export class SessionStore {
  readonly root: string;

  constructor(options: SessionStoreOptions = {}) {
    this.root = options.dir ?? path.join(os.homedir(), '.alia', 'sessions');
  }

  projectDir(workspace: string): string {
    return path.join(this.root, projectFolderName(workspace));
  }

  /** Creates the session's files. The id is generated unless given. */
  create(opts: { workspace: string; model: string; title?: string; id?: string }): SessionInfo {
    const id = opts.id ?? newSessionId();
    assertId(id);
    if (this.locate(id)) throw new Error(`Session "${id}" already exists.`);
    const workspace = path.resolve(opts.workspace);
    const dir = this.projectDir(workspace);
    fs.mkdirSync(dir, { recursive: true });
    const meta: MetaFile = {
      version: 1,
      id,
      title: opts.title ?? '',
      titleSource: opts.title ? 'user' : 'auto',
      workspace,
      model: opts.model,
      createdAt: new Date().toISOString(),
    };
    writeAtomic(path.join(dir, `${id}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), '', { flag: 'a' });
    return this.info(id)!;
  }

  exists(id: string): boolean {
    assertId(id);
    return this.locate(id) !== undefined;
  }

  info(id: string): SessionInfo | undefined {
    assertId(id);
    const dir = this.locate(id);
    return dir ? this.readInfo(dir, id) : undefined;
  }

  /** The conversation, rebuilt from its file. Undefined if there is no such session. */
  load(id: string): LoadedSession | undefined {
    assertId(id);
    const dir = this.locate(id);
    if (!dir) return undefined;
    const info = this.readInfo(dir, id);
    if (!info) return undefined;
    const { entries, skipped } = readEntries(path.join(dir, `${id}.jsonl`));
    return { info, messages: applyEntries(entries), skipped };
  }

  /** Newest first. With `workspace`, only that project's sessions. */
  list(opts: { workspace?: string; limit?: number } = {}): SessionInfo[] {
    const dirs = opts.workspace ? [this.projectDir(opts.workspace)] : this.projectDirs();
    const out: SessionInfo[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of files) {
        if (!f.endsWith('.meta.json')) continue;
        const info = this.readInfo(dir, f.slice(0, -'.meta.json'.length));
        if (info && (!opts.workspace || sameWorkspace(info.workspace, opts.workspace))) out.push(info);
      }
    }
    out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  /**
   * Case-insensitive substring search over titles and the text of user and assistant messages.
   * Tool output and pinned skill text are not searched (file dumps and playbooks would match
   * almost everything). Reads each session file; there is no index in v1.
   */
  search(text: string, opts: { workspace?: string; limit?: number; maxMatchesPerSession?: number } = {}): SearchHit[] {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];
    const perSession = opts.maxMatchesPerSession ?? 3;
    const hits: SearchHit[] = [];
    for (const info of this.list({ workspace: opts.workspace })) {
      const matches: SearchMatch[] = [];
      if (info.title.toLowerCase().includes(needle)) matches.push({ where: 'title', snippet: info.title });
      const loaded = this.load(info.id);
      for (const m of loaded?.messages ?? []) {
        if (matches.length >= perSession) break;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const body = searchableText(m);
        const at = body.toLowerCase().indexOf(needle);
        if (at < 0) continue;
        matches.push({ where: m.role, snippet: snippetAround(body, at, needle.length) });
      }
      if (matches.length > 0) hits.push({ info, matches });
      if (opts.limit && hits.length >= opts.limit) break;
    }
    return hits;
  }

  /** Sets a title chosen by the user. It is never replaced by an automatic one afterwards. */
  rename(id: string, title: string): SessionInfo {
    const clean = title.replace(/\s+/g, ' ').trim();
    if (!clean) throw new Error('A title cannot be empty.');
    return this.updateMeta(id, { title: clean, titleSource: 'user' });
  }

  /** Updates what the session records about itself (the model in use). */
  update(id: string, patch: { model?: string }): SessionInfo {
    return this.updateMeta(id, patch);
  }

  delete(id: string): boolean {
    assertId(id);
    const dir = this.locate(id);
    if (!dir) return false;
    fs.rmSync(path.join(dir, `${id}.jsonl`), { force: true });
    fs.rmSync(path.join(dir, `${id}.meta.json`), { force: true });
    return true;
  }

  /**
   * A writer that keeps a session's file in step with a live history array. Call `sync(messages)`
   * after any change. `initial` is what is already saved (a resumed session's messages).
   * The files are created on the first real message, so opening a window leaves nothing behind.
   */
  recorder(id: string, opts: { workspace: string; getModel: () => string; initial?: ChatMessage[] }): SessionRecorder {
    assertId(id);
    return new SessionRecorder(this, id, opts);
  }

  // ---- internals shared with SessionRecorder -------------------------------------------------

  /** @internal */
  locate(id: string): string | undefined {
    for (const dir of this.projectDirs()) {
      if (fs.existsSync(path.join(dir, `${id}.meta.json`))) return dir;
    }
    return undefined;
  }

  /** @internal */
  setAutoTitle(id: string, title: string): void {
    const dir = this.locate(id);
    if (!dir) return;
    const meta = this.readMeta(dir, id);
    if (!meta || meta.titleSource === 'user' || meta.title) return;
    this.updateMeta(id, { title });
  }

  /** @internal */
  clearAutoTitle(id: string): void {
    const dir = this.locate(id);
    const meta = dir ? this.readMeta(dir, id) : undefined;
    if (!dir || !meta || meta.titleSource === 'user' || !meta.title) return;
    this.updateMeta(id, { title: '' });
  }

  private projectDirs(): string[] {
    try {
      return fs
        .readdirSync(this.root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(this.root, e.name));
    } catch {
      return [];
    }
  }

  private readMeta(dir: string, id: string): MetaFile | undefined {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, `${id}.meta.json`), 'utf-8'));
      return meta && typeof meta.id === 'string' && typeof meta.workspace === 'string' ? meta : undefined;
    } catch {
      return undefined; // a damaged meta file hides that one session, not the whole list
    }
  }

  private readInfo(dir: string, id: string): SessionInfo | undefined {
    const meta = this.readMeta(dir, id);
    if (!meta) return undefined;
    let updated = 0;
    for (const f of [`${id}.jsonl`, `${id}.meta.json`]) {
      try {
        updated = Math.max(updated, fs.statSync(path.join(dir, f)).mtimeMs);
      } catch {
        // file missing: ignore
      }
    }
    return {
      id: meta.id,
      title: meta.title || FALLBACK_TITLE,
      titleSource: meta.titleSource === 'user' ? 'user' : 'auto',
      workspace: meta.workspace,
      model: meta.model,
      createdAt: meta.createdAt,
      updatedAt: new Date(updated || Date.parse(meta.createdAt)).toISOString(),
    };
  }

  private updateMeta(id: string, patch: Partial<Pick<MetaFile, 'title' | 'titleSource' | 'model'>>): SessionInfo {
    assertId(id);
    const dir = this.locate(id);
    const meta = dir ? this.readMeta(dir, id) : undefined;
    if (!dir || !meta) throw new Error(`Session "${id}" not found.`);
    writeAtomic(path.join(dir, `${id}.meta.json`), JSON.stringify({ ...meta, ...patch }, null, 2) + '\n');
    return this.readInfo(dir, id)!;
  }
}

function snippetAround(text: string, at: number, length: number, context = 40): string {
  const start = Math.max(0, at - context);
  const end = Math.min(text.length, at + length + context);
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`;
}

/**
 * Writes the changes between the last saved history and the live one. It compares messages by
 * reference, so a sync costs a pointer check per message; only what changed is written.
 */
export class SessionRecorder {
  private persisted: ChatMessage[];
  private created: boolean;
  private needsNewline = false;
  private titled = false;
  private readonly file: string;

  constructor(
    private store: SessionStore,
    readonly id: string,
    private opts: { workspace: string; getModel: () => string; initial?: ChatMessage[] }
  ) {
    this.persisted = (opts.initial ?? []).slice();
    this.file = path.join(store.projectDir(opts.workspace), `${id}.jsonl`);
    this.created = store.exists(id);
    if (this.created) this.needsNewline = this.endsMidLine();
  }

  /** Saves what changed since the last call. Never throws: a full disk must not stop the conversation. */
  sync(messages: ChatMessage[]): void {
    try {
      this.write(messages);
    } catch {
      // Could not save this time; the next sync retries from the same baseline.
    }
  }

  /** Records the model in use (for a switch made mid-conversation). */
  setModel(model: string): void {
    try {
      if (this.created) this.store.update(this.id, { model });
    } catch {
      // not critical
    }
  }

  private write(messages: ChatMessage[]): void {
    if (!this.created) {
      // Wait for a real message: a system prompt alone is not a conversation.
      if (!messages.some((m) => m.role !== 'system')) return;
      this.store.create({ id: this.id, workspace: this.opts.workspace, model: this.opts.getModel() });
      this.created = true;
    }
    const file = this.file;

    // History shrank or was replaced (/clear, /compact): rewrite the file so old content is really gone.
    if (messages.length < this.persisted.length) {
      writeAtomic(file, JSON.stringify({ t: 'replace', messages } satisfies Entry) + '\n');
      this.persisted = messages.slice();
      this.needsNewline = false;
      // An automatic title came from what was just erased; drop it (a title the user chose stays).
      this.store.clearAutoTitle(this.id);
      this.titled = false;
      this.updateTitle(messages);
      return;
    }

    const lines: string[] = [];
    for (let i = 0; i < this.persisted.length; i++) {
      if (messages[i] === this.persisted[i]) continue;
      // A different object is not necessarily different content (a resumed session's system prompt).
      if (JSON.stringify(messages[i]) === JSON.stringify(this.persisted[i])) continue;
      lines.push(JSON.stringify({ t: 'set', i, m: messages[i] } satisfies Entry));
    }
    for (let i = this.persisted.length; i < messages.length; i++) {
      lines.push(JSON.stringify({ t: 'msg', m: messages[i] } satisfies Entry));
    }
    if (lines.length > 0) {
      // If a crash cut the last line short, start on a fresh line so the new entry stays readable.
      fs.appendFileSync(file, (this.needsNewline ? '\n' : '') + lines.join('\n') + '\n', 'utf-8');
      this.needsNewline = false;
    }
    this.persisted = messages.slice();
    this.updateTitle(messages);
  }

  private updateTitle(messages: ChatMessage[]): void {
    if (this.titled) return;
    const firstUser = messages.find((m) => m.role === 'user');
    if (!firstUser) return;
    this.store.setAutoTitle(this.id, deriveTitle(messageText(firstUser)));
    this.titled = true;
  }

  private endsMidLine(): boolean {
    try {
      const fd = fs.openSync(this.file, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size === 0) return false;
        const buf = Buffer.alloc(1);
        fs.readSync(fd, buf, 0, 1, size - 1);
        return buf[0] !== 0x0a;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return false;
    }
  }
}
