import type { CommandInfo, CompactResult, ContextUsage, ModelList } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

/** The commands the page carries out itself. Everything else typed after a slash goes to the engine (skills). */
export const LOCAL_COMMANDS = ['help', 'models', 'model', 'tokens', 'skills', 'clear', 'compact', 'config'] as const;
export type LocalCommand = (typeof LOCAL_COMMANDS)[number];

export const isLocalCommand = (name: string): name is LocalCommand => (LOCAL_COMMANDS as readonly string[]).includes(name);

const line = (c: CommandInfo) => `/${c.name}${c.usage && c.usage !== `/${c.name}` ? ` — ${c.usage.replace(/^\/\S+\s*/, '')}` : ''}  ${c.description}`.replace(/\s+$/, '');

/** /help: every command the composer offers (built-ins, the app's own, and the skills). */
export function helpText(commands: CommandInfo[]): string {
  if (commands.length === 0) return t.composer.local.none;
  return [t.composer.local.helpTitle, ...commands.map((c) => `  ${line(c)}`)].join('\n');
}

/** /skills: the skills that are available. */
export function skillsText(commands: CommandInfo[]): string {
  const skills = commands.filter((c) => c.kind === 'skill');
  if (skills.length === 0) return t.composer.local.none;
  return [t.composer.local.skillsTitle, ...skills.map((c) => `  /${c.name}  ${c.description}`)].join('\n');
}

/** /models: the configured models, the current one marked, and what else the service offers. */
export function modelsText(list: ModelList): string {
  const configured = list.configured.map((m) => `  ${m.id === list.current ? '●' : '○'} ${m.id}${m.name !== m.id ? ` (${m.name})` : ''}`);
  const rest = list.remote.filter((id) => !list.configured.some((m) => m.id === id));
  return [t.composer.local.modelsTitle, ...configured, ...(rest.length ? [t.composer.local.modelsRemote, ...rest.map((id) => `  ○ ${id}`)] : [])].join('\n');
}

/** /tokens */
export function tokensText(usage: ContextUsage): string {
  return t.composer.local.tokens(usage.tokens, usage.limit, usage.percent, usage.messages);
}

/** What to say about a /compact that did not compact (a successful one announces itself as a "context compacted" row). */
export function compactMessage(result: CompactResult): string | undefined {
  switch (result.status) {
    case 'nothing_to_compact':
      return t.composer.local.compact.nothing;
    case 'busy':
      return t.composer.local.compact.busy;
    case 'failed':
      return t.composer.local.compact.failed(result.error);
    case 'cancelled':
      return t.composer.local.compact.cancelled;
    default:
      return undefined;
  }
}

/** A file size the way a person reads it ("1,2 KB"). */
export function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0).replace('.', ',')} ${units[i]}`;
}
