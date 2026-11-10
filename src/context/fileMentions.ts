import fs from 'node:fs';
import path from 'node:path';
import { detectBinaryFile } from '../tools/fileUtils.js';

export interface AttachedFile {
  /** The mention as typed by the user (e.g. `@src/index.ts`). */
  mention: string;
  /** Best-effort display path (relative to cwd when possible). */
  displayPath: string;
  /** Line count for files, entry count for directories. */
  lines: number;
  chars: number;
  truncated: boolean;
  isDir: boolean;
}

export interface MentionResolution {
  /** The prompt to send to the model (original text + attached file contents). */
  prompt: string;
  attachments: AttachedFile[];
  /** Human-readable warnings for mentions that could not be attached. */
  errors: string[];
}

/** Per-file attachment cap (keeps head and tail when exceeded). */
const MAX_FILE_CHARS = 100_000;
/** Total attachment budget per prompt to protect the context window. */
const MAX_TOTAL_CHARS = 300_000;
/** Maximum entries listed when attaching a directory. */
const MAX_DIR_ENTRIES = 200;

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', mjs: 'js', cjs: 'js',
  py: 'python', rs: 'rust', go: 'go', java: 'java', rb: 'ruby', php: 'php',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cc: 'cpp', cs: 'csharp',
  json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  md: 'markdown', markdown: 'markdown', html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less', sh: 'bash', bash: 'bash',
  zsh: 'bash', fish: 'bash', ps1: 'powershell', bat: 'batch',
  sql: 'sql', xml: 'xml', svg: 'xml', txt: '', env: '',
};

/**
 * Matches `@mention` tokens only when the `@` starts a new word
 * (start of string or preceded by whitespace) so emails like `user@host`
 * are not mistaken for file mentions.
 */
const MENTION_REGEX = /(?<!\S)@([^\s@]+)/g;

/** Quick check used to skip resolution work entirely when no mentions exist. */
export function hasFileMentions(input: string): boolean {
  return /(?<!\S)@[^\s@]/.test(input);
}

/**
 * Resolves every `@path` mention in the user input and builds an enriched
 * prompt containing the current contents of each mentioned file (or a
 * listing for directories). The original text is preserved verbatim so the
 * model can see which files the user explicitly referenced.
 */
export function resolveFileMentions(input: string, cwd: string): MentionResolution {
  const attachments: AttachedFile[] = [];
  const errors: string[] = [];
  const blocks: string[] = [];
  const seen = new Set<string>();
  let budget = MAX_TOTAL_CHARS;

  MENTION_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = MENTION_REGEX.exec(input)) !== null) {
    const raw = match[1];
    const cleaned = cleanMention(raw);
    if (!cleaned) continue;

    const abs = path.isAbsolute(cleaned) ? path.normalize(cleaned) : path.resolve(cwd, cleaned);
    if (seen.has(abs.toLowerCase())) continue; // dedupe repeated mentions
    seen.add(abs.toLowerCase());

    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      errors.push(`@${cleaned}: file or directory not found`);
      continue;
    }

    // Normalize to forward slashes so attached paths match what the user typed
    // (path.relative returns platform separators, e.g. "src\tools" on Windows).
    const displayPath = (path.relative(cwd, abs) || path.basename(abs) || cleaned)
      .split(path.sep)
      .join('/');

    try {
      if (stat.isDirectory()) {
        const children = fs.readdirSync(abs, { withFileTypes: true });
        const names = children
          .slice(0, MAX_DIR_ENTRIES)
          .map((d) => d.name + (d.isDirectory() ? '/' : ''));
        const omitted = children.length - names.length;
        const listing =
          names.join(', ') + (omitted > 0 ? `, … (+${omitted} more)` : '');

        blocks.push(
          `<directory path="${displayPath}" entries="${children.length}">\n${listing}\n</directory>`
        );
        attachments.push({
          mention: `@${cleaned}`,
          displayPath,
          lines: names.length,
          chars: listing.length,
          truncated: omitted > 0,
          isDir: true,
        });
      } else {
        const binaryCheck = detectBinaryFile(abs);
        if (binaryCheck.binary) {
          errors.push(`@${cleaned}: binary file (${binaryCheck.reason}) — not attached`);
          continue;
        }

        let content = fs.readFileSync(abs, 'utf-8');
        let truncated = false;
        if (content.length > MAX_FILE_CHARS) {
          const head = content.slice(0, Math.floor(MAX_FILE_CHARS * 0.8));
          const tail = content.slice(-Math.floor(MAX_FILE_CHARS * 0.2));
          const omitted = content.length - MAX_FILE_CHARS;
          content = `${head}\n\n[... ${omitted} characters truncated to fit the attachment limit ...]\n\n${tail}`;
          truncated = true;
        }

        if (content.length > budget) {
          errors.push(
            `@${cleaned}: skipped — total attachment size would exceed the ${MAX_TOTAL_CHARS} character context budget`
          );
          continue;
        }
        budget -= content.length;

        const lines = content.split('\n').length;
        const lang = LANGUAGE_BY_EXT[path.extname(abs).slice(1).toLowerCase()] ?? '';
        const fence = '`'.repeat(Math.max(3, longestBacktickRun(content) + 1));

        blocks.push(
          `<file path="${displayPath}" lines="${lines}">\n${fence}${lang}\n${content}\n${fence}\n</file>`
        );
        attachments.push({
          mention: `@${cleaned}`,
          displayPath,
          lines,
          chars: content.length,
          truncated,
          isDir: false,
        });
      }
    } catch (err: any) {
      errors.push(`@${cleaned}: could not read — ${err.message}`);
    }
  }

  if (blocks.length === 0) {
    return { prompt: input, attachments, errors };
  }

  const prompt = `${input}

<file_attachments>
The user referenced the files below via @mentions in their message. Their current
contents are included here so you can work with them without re-reading them.

${blocks.join('\n\n')}
</file_attachments>`;

  return { prompt, attachments, errors };
}

/** Strips surrounding quotes/brackets and trailing punctuation from a mention. */
function cleanMention(raw: string): string {
  let m = raw.replace(/^[`'"(<]+/, '').replace(/[`'")>,.;:!?]+$/, '');
  while (m.startsWith('./')) m = m.slice(2);
  return m;
}

function longestBacktickRun(content: string): number {
  const runs = content.match(/`+/g);
  if (!runs) return 0;
  return runs.reduce((max, run) => Math.max(max, run.length), 0);
}
