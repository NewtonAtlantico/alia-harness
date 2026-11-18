import type { SkillRegistry } from '../skills/skillLoader.js';

/**
 * The `/commands` a front-end offers in its slash menu. Core owns the list (built-ins and one
 * entry per available skill) so the terminal prompt and the desktop palette show the same thing;
 * a front-end adds the commands only it can perform (`/config`, `/exit`).
 */
export type CommandKind = 'builtin' | 'skill' | 'host';

export interface CommandInfo {
  /** Without the leading slash. */
  name: string;
  description: string;
  usage?: string;
  /** Picking it in a menu should leave the cursor ready for arguments. */
  acceptsArgs: boolean;
  kind: CommandKind;
}

export type HostCommand = Omit<CommandInfo, 'kind' | 'acceptsArgs'> & { acceptsArgs?: boolean };

/** Commands every session understands. The front-end decides how to carry them out. */
export const CORE_COMMANDS: readonly CommandInfo[] = [
  { name: 'help', description: 'Show available slash commands and usage', acceptsArgs: false, kind: 'builtin' },
  { name: 'tools', description: 'List all available tools and parameters', acceptsArgs: false, kind: 'builtin' },
  { name: 'skills', description: 'List skills and whether they are available', acceptsArgs: false, kind: 'builtin' },
  { name: 'models', description: 'List models from config and remote endpoint', acceptsArgs: false, kind: 'builtin' },
  { name: 'model', description: 'Switch active model (e.g. /model gpt-oss:20b)', usage: '/model <id>', acceptsArgs: true, kind: 'builtin' },
  { name: 'clear', description: 'Reset conversation history', acceptsArgs: false, kind: 'builtin' },
  { name: 'compact', description: 'Summarize the history to free up context', acceptsArgs: false, kind: 'builtin' },
  { name: 'tokens', description: 'Show estimated context tokens used', acceptsArgs: false, kind: 'builtin' },
];

const key = (name: string) => name.replace(/^\//, '').trim().toLowerCase();

export class CommandRegistry {
  private host: CommandInfo[] = [];

  constructor(private getSkills: () => SkillRegistry) {}

  /**
   * Adds a command only the front-end can perform. A name already taken by a built-in or another
   * front-end command is rejected; a skill with the same name gives way to it.
   */
  register(command: HostCommand): void {
    const name = key(command.name);
    if (!name || /\s/.test(name)) throw new Error(`Invalid command name: "${command.name}"`);
    if (CORE_COMMANDS.some((c) => c.name === name) || this.host.some((c) => c.name === name)) {
      throw new Error(`Command "/${name}" already exists.`);
    }
    this.host.push({
      name,
      description: command.description,
      usage: command.usage,
      acceptsArgs: command.acceptsArgs ?? false,
      kind: 'host',
    });
  }

  /** Built-ins, then front-end commands, then one per available skill. Computed on every call, so it follows the skills. */
  list(): CommandInfo[] {
    const out: CommandInfo[] = [...CORE_COMMANDS, ...this.host];
    const taken = new Set(out.map((c) => c.name));
    for (const skill of this.getSkills().available()) {
      const name = key(skill.name);
      if (taken.has(name)) continue;
      taken.add(name);
      out.push({
        name: skill.name,
        description: skill.description.replace(/\s+/g, ' ').trim(),
        usage: `/${skill.name} <input>`,
        acceptsArgs: true,
        kind: 'skill',
      });
    }
    return out;
  }

  get(name: string): CommandInfo | undefined {
    const k = key(name);
    return this.list().find((c) => c.name.toLowerCase() === k);
  }

  /** Skills that could not get a command because a built-in or front-end command has their name. */
  skippedSkills(): string[] {
    const taken = new Set([...CORE_COMMANDS, ...this.host].map((c) => c.name));
    return this.getSkills()
      .available()
      .filter((s) => taken.has(key(s.name)))
      .map((s) => s.name);
  }
}
