import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILL_TAG_PREFIX } from '../context/contextManager.js';

/**
 * Skills: reusable, step-by-step playbooks stored as `<root>/<dir>/SKILL.md`
 * (YAML frontmatter + markdown body, plus optional references/, scripts/, assets/).
 *
 * Progressive disclosure, as in Claude Code:
 *   1. only a short catalog (name + description) lives in the system prompt;
 *   2. the full SKILL.md body is loaded on demand (`use_skill` tool or `/skill-name`);
 *   3. references/scripts/assets are read by the model only when a step needs them.
 */

export interface Skill {
  /** Identifier used by `use_skill` and `/name` (frontmatter `name`, else the folder name). */
  name: string;
  description: string;
  /** Absolute path of the skill folder. */
  dir: string;
  /** Absolute path of SKILL.md. */
  file: string;
  /** Markdown body (frontmatter stripped). */
  body: string;
  /** Tool names this skill needs (frontmatter `requires`); hidden when not satisfied. */
  requires: string[];
  /** Which root it came from (bundled / user / project / env). */
  source: string;
}

export interface SkillRoot {
  label: string;
  dir: string;
}

export interface SkillRegistryOptions {
  /** Roots to scan, lowest precedence first. Defaults to {@link defaultSkillRoots}. */
  roots?: SkillRoot[];
  /** Returns the currently registered tool names (used to evaluate `requires`). */
  getToolNames?: () => string[];
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Minimal YAML-frontmatter parser: `key: value`, quoted values, folded/literal
 * block scalars (`>` / `|`) and plain scalars continued on indented lines.
 * Enough for SKILL.md files without pulling in a YAML dependency.
 */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) return { data: {}, body: text };

  const lines = match[1].split(/\r?\n/);
  const data: Record<string, string> = {};

  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const first = kv[2].trim();

    const continuation: string[] = [];
    while (i + 1 < lines.length && (lines[i + 1].trim() === '' || /^\s+/.test(lines[i + 1]))) {
      continuation.push(lines[++i].trim());
    }

    const blockMatch = /^([>|])[+-]?$/.exec(first);
    let value: string;
    if (blockMatch) {
      value =
        blockMatch[1] === '|'
          ? continuation.join('\n').trim()
          : continuation.filter(Boolean).join(' ');
    } else {
      value = [first, ...continuation.filter(Boolean)].join(' ');
      value = value.replace(/^(['"])([\s\S]*)\1$/, '$2');
    }
    data[key] = value.trim();
  }

  return { data, body: match[2] };
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .replace(/^\[|\]$/g, '')
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** `skills/` folder shipped next to the harness (works from both src/ and dist/). */
export function bundledSkillsDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', '..', 'skills');
}

/**
 * Lowest to highest precedence: bundled < user (~/.alia/skills) < project
 * (<cwd>/.alia/skills) < ALIA_SKILLS_DIR (path-delimited list).
 */
export function defaultSkillRoots(cwd: string = process.cwd()): SkillRoot[] {
  const roots: SkillRoot[] = [
    { label: 'bundled', dir: bundledSkillsDir() },
    { label: 'user', dir: path.join(os.homedir(), '.alia', 'skills') },
    { label: 'project', dir: path.join(cwd, '.alia', 'skills') },
  ];
  const extra = process.env.ALIA_SKILLS_DIR;
  if (extra) {
    for (const dir of extra.split(path.delimiter).filter(Boolean)) {
      roots.push({ label: 'env', dir: path.resolve(dir) });
    }
  }
  return roots;
}

const toPosix = (p: string) => p.replace(/\\/g, '/');

export class SkillRegistry {
  private skills = new Map<string, Skill>();
  private roots: SkillRoot[];
  private getToolNames: () => string[];
  readonly warnings: string[] = [];

  constructor(options: SkillRegistryOptions = {}) {
    this.roots = options.roots ?? defaultSkillRoots(options.cwd);
    this.getToolNames = options.getToolNames ?? (() => []);
  }

  /** (Re)scans every root. Only direct children of a root are considered (no recursion). */
  load(): void {
    this.skills.clear();
    this.warnings.length = 0;
    const seenRoots = new Set<string>();

    for (const root of this.roots) {
      const resolved = path.resolve(root.dir);
      if (seenRoots.has(resolved) || !fs.existsSync(resolved)) continue;
      seenRoots.add(resolved);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(resolved, { withFileTypes: true });
      } catch (err: any) {
        this.warnings.push(`Cannot read skills folder ${resolved}: ${err.message}`);
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(resolved, entry.name);
        const file = path.join(dir, 'SKILL.md');
        if (!fs.existsSync(file)) continue;

        try {
          const { data, body } = parseFrontmatter(fs.readFileSync(file, 'utf-8'));
          const name = data.name && /^[\w.-]+$/.test(data.name) ? data.name : entry.name;
          if (!data.description) {
            this.warnings.push(`Skill "${name}" (${file}) has no description; it will be hard to match.`);
          }
          const skill: Skill = {
            name,
            description: data.description ?? '',
            dir,
            file,
            body: body.trim(),
            requires: parseList(data.requires),
            source: root.label,
          };
          // Later roots override earlier ones with the same name.
          this.skills.set(name, skill);
        } catch (err: any) {
          this.warnings.push(`Failed to load skill at ${file}: ${err.message}`);
        }
      }
    }
  }

  all(): Skill[] {
    return Array.from(this.skills.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): Skill | undefined {
    return this.skills.get(name.replace(/^\//, '').trim());
  }

  /** Requirements (from frontmatter `requires`) that no registered tool satisfies. */
  missingRequirements(skill: Skill): string[] {
    if (skill.requires.length === 0) return [];
    const tools = this.getToolNames();
    // A tool satisfies a requirement by exact name or as an MCP-prefixed name (`mcp__server__<req>`).
    return skill.requires.filter(
      (req) => !tools.some((t) => t === req || t.endsWith(`__${req}`))
    );
  }

  isAvailable(skill: Skill): boolean {
    return this.missingRequirements(skill).length === 0;
  }

  available(): Skill[] {
    return this.all().filter((s) => this.isAvailable(s));
  }

  /** Skill body with `.claude/skills/<name>` references rewritten to real on-disk paths. */
  renderBody(skill: Skill): string {
    const byDir = new Map<string, Skill>();
    for (const s of this.skills.values()) byDir.set(path.basename(s.dir), s);

    return skill.body.replace(
      /(?:~\/|\$HOME\/)?\.claude\/skills\/([A-Za-z0-9._-]+)/g,
      (whole, id: string) => {
        const target = byDir.get(id) ?? this.skills.get(id);
        return target ? toPosix(target.dir) : whole;
      }
    );
  }
}

// ---------------------------------------------------------------------------
// Prompt formatting
// ---------------------------------------------------------------------------

const HARNESS_NOTES = [
  'You are running inside the Alia harness, not Claude Code. Adapt this skill as follows:',
  '- Tools: read_file, write_file, edit_file, list_files, grep_search, run_bash, use_skill. Map any other tool named below onto these.',
  '- The `Skill` tool is `use_skill`. To run another skill this one mentions, call use_skill with its name.',
  '- There is no AskUserQuestion, Task/subagent or MCP tool. Ask the user plain-text questions, then end your turn and wait for the answer. Never invent answers.',
  '- Paths inside this skill (references/, scripts/, assets/, templates) are relative to the skill folder shown in `dir`. Read them with read_file only when a step needs them.',
].join('\n');

/**
 * Full skill text handed to the model. Starts with {@link SKILL_TAG_PREFIX} so the
 * context manager never prunes it mid-task.
 */
export function formatSkillForModel(skill: Skill, registry: SkillRegistry): string {
  return [
    `${SKILL_TAG_PREFIX}name="${skill.name}" dir="${toPosix(skill.dir)}">`,
    HARNESS_NOTES,
    '',
    registry.renderBody(skill),
    '</skill>',
  ].join('\n');
}

/** Prompt used when the user invokes a skill directly with `/skill-name <input>`. */
export function buildSkillInvocationPrompt(
  skill: Skill,
  registry: SkillRegistry,
  input: string
): string {
  const request = input.trim()
    ? input.trim()
    : "(none given. Begin with the skill's own first step and ask me for any input you need.)";
  return [
    `I invoked the "${skill.name}" skill. It is already loaded below, so do not call use_skill for it again. Follow it for this request.`,
    '',
    formatSkillForModel(skill, registry),
    '',
    `Request / input: ${request}`,
  ].join('\n');
}

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  return cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 40)).trimEnd() + '…';
}

/** System-prompt section listing available skills (name + description only). */
export function buildSkillCatalog(registry: SkillRegistry): string {
  const skills = registry.available();
  if (skills.length === 0) return '';
  const lines = skills.map((s) => `- ${s.name}: ${shorten(s.description || '(no description)', 500)}`);
  return [
    '## Skills',
    'Skills are specialised, step-by-step playbooks for recurring kinds of work. Before starting a task, check the list below.',
    'If one matches, call `use_skill` with its exact name FIRST, then follow the returned instructions closely.',
    'Do not guess a skill\'s content from its name, and do not load skills that do not match the task.',
    'If the user already invoked a skill (their message contains a <skill ...> block), it is loaded: do not call use_skill for it again.',
    '',
    ...lines,
  ].join('\n');
}
