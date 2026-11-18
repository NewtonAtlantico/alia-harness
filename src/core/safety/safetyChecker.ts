import { RunCancelledError, raceAbort } from '../abort.js';
import { PermissionMatch, PermissionStore, matchesPrefix } from './permissionStore.js';

export interface DangerousCommandRule {
  pattern: RegExp;
  reason: string;
}

export const DANGEROUS_PATTERNS: DangerousCommandRule[] = [
  // Deletion commands
  { pattern: /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*\s+|--recursive)/i, reason: 'Recursive file deletion (rm -r)' },
  { pattern: /\b(rmdir|rd)\s+(\/[sS])/i, reason: 'Recursive directory deletion (rmdir /s)' },
  { pattern: /\bdel\s+(\/[fF\s]*\/[sS]|\/[sS])/i, reason: 'Recursive file deletion (del /s)' },
  { pattern: /\bRemove-Item\b.*-Recurse/i, reason: 'PowerShell recursive deletion' },
  { pattern: /\bdel\b.*\*\.\*/i, reason: 'Mass file deletion wildcard (*.*)' },

  // Disk / OS tampering
  { pattern: /\b(format|diskpart|mkfs|dd\s+if=)/i, reason: 'Disk or filesystem formatting / overwrite' },
  { pattern: /\b(shutdown|reboot|init\s+0|init\s+6)\b/i, reason: 'System shutdown or reboot' },

  // Dangerous Git
  { pattern: /\bgit\s+reset\s+--hard/i, reason: 'Destructive git hard reset (uncommitted work will be lost)' },
  { pattern: /\bgit\s+clean\s+(-[a-zA-Z]*f)/i, reason: 'Force removal of untracked files (git clean -f)' },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/i, reason: 'Force pushing to remote repository' },

  // Dangerous database
  { pattern: /\bDROP\s+(DATABASE|TABLE|SCHEMA)\b/i, reason: 'Database drop statement' },

  // Arbitrary process termination
  { pattern: /\btaskkill\b.*\/f/i, reason: 'Force termination of system processes' },
  { pattern: /\bkill\s+-9\b/i, reason: 'Force kill process' },
];

export interface SafetyCheckResult {
  isDangerous: boolean;
  reasons: string[];
}

/** What the user decided about one command. */
export type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';

/**
 * - `ask-dangerous`: prompt only for commands that match {@link DANGEROUS_PATTERNS} (the CLI default).
 * - `ask-commands`: prompt for every command that is not on the project's allowlist (the desktop default).
 * - `auto`: never prompt.
 *
 * A dangerous command prompts in every mode except `auto`, and can never be allowlisted.
 */
export type PermissionMode = 'ask-dangerous' | 'ask-commands' | 'auto';

/**
 * What a confirmation handler may return. A plain boolean is the older contract and still works
 * (`true` = allow once, `false` = deny). The object form lets "always allow" choose a rule: by
 * default the exact command; `match: 'prefix'` allows that command plus plain arguments.
 */
export type PermissionAnswer =
  | boolean
  | PermissionDecision
  | { decision: PermissionDecision; match?: PermissionMatch; command?: string };

export function normalizeAnswer(answer: PermissionAnswer): { decision: PermissionDecision; match?: PermissionMatch; command?: string } {
  if (answer === true) return { decision: 'allow_once' };
  if (answer === false) return { decision: 'deny' };
  if (typeof answer === 'string') return { decision: answer };
  return answer;
}

export interface SafetyConfirmationContext {
  command: string;
  /** Why the command is dangerous. Empty for a plain command that only needs approval (`ask-commands`). */
  reasons: string[];
  /** True when the command matches a destructive pattern. */
  dangerous: boolean;
  /** Whether "always allow" is offered: never for a dangerous command. */
  canAlwaysAllow: boolean;
  requester?: string;
  /** The model's id for the tool call that wants to run this command. */
  toolCallId?: string;
  /** Aborts if the run is cancelled while the question is open: dismiss the prompt. */
  signal?: AbortSignal;
}

export type SafetyConfirmationHandler = (
  context: SafetyConfirmationContext
) => Promise<PermissionAnswer>;

export interface SafetyCheckerOptions {
  /** Shorthand for `mode: 'auto'`. `mode` wins when both are given. */
  autoApprove?: boolean;
  mode?: PermissionMode;
  onConfirm?: SafetyConfirmationHandler;
  /** Where "always allow" is remembered, and read from in `ask-commands`. Without it nothing is remembered. */
  permissions?: PermissionStore;
  getScopeLabel?: () => string | undefined;
  onAutoApprove?: (command: string) => void;
}

export interface AuthorizeOptions {
  signal?: AbortSignal;
  toolCallId?: string;
}

/**
 * Decides whether a shell command may run. Handlers are per instance (no process-wide defaults).
 * Without `onConfirm`, a command that needs approval is denied rather than run unprompted.
 */
export class SafetyChecker {
  readonly mode: PermissionMode;
  private onConfirm?: SafetyConfirmationHandler;
  private permissions?: PermissionStore;
  private getScopeLabelFn?: () => string | undefined;
  private onAutoApproveFn?: (command: string) => void;

  constructor(options: boolean | SafetyCheckerOptions = false) {
    if (typeof options === 'boolean') {
      this.mode = options ? 'auto' : 'ask-dangerous';
    } else {
      this.mode = options.mode ?? (options.autoApprove ? 'auto' : 'ask-dangerous');
      this.onConfirm = options.onConfirm;
      this.permissions = options.permissions;
      this.getScopeLabelFn = options.getScopeLabel;
      this.onAutoApproveFn = options.onAutoApprove;
    }
  }

  /**
   * Check if a shell command matches any destructive or dangerous pattern.
   */
  evaluateCommand(command: string): SafetyCheckResult {
    const reasons: string[] = [];

    for (const rule of DANGEROUS_PATTERNS) {
      if (rule.pattern.test(command)) {
        reasons.push(rule.reason);
      }
    }

    return {
      isDangerous: reasons.length > 0,
      reasons,
    };
  }

  /**
   * Decides whether `command` may run, asking the user when the mode requires it.
   * Returns `{ approved: false, reason }` when it may not (the reason goes back to the model).
   */
  async authorize(command: string, options: AuthorizeOptions = {}): Promise<{ approved: boolean; reason?: string }> {
    const { signal, toolCallId } = options;
    const check = this.evaluateCommand(command);
    const dangerous = check.isDangerous;

    if (this.mode === 'auto') {
      if (dangerous) this.onAutoApproveFn?.(command);
      return { approved: true };
    }

    if (!dangerous) {
      if (this.mode === 'ask-dangerous') return { approved: true };
      // ask-commands: only a command the user already allowed in this project skips the prompt.
      if (this.permissions?.isAllowed(command)) return { approved: true };
    }

    const handler = this.onConfirm;
    if (!handler) {
      return {
        approved: false,
        reason: dangerous
          ? `Potentially destructive command detected: "${command}". Reasons: ${check.reasons.join('; ')}, but no confirmation handler is available.`
          : `Command "${command}" needs the user's approval, but no confirmation handler is available.`,
      };
    }

    const cancelledResult = {
      approved: false,
      reason: `Cancelled by user before the command was approved: "${command}"`,
    };
    if (signal?.aborted) return cancelledResult;

    let answer: PermissionAnswer;
    try {
      // The user may cancel the run while the approval card is open; never leave the run waiting on it.
      answer = await raceAbort(
        handler({
          command,
          reasons: check.reasons,
          dangerous,
          canAlwaysAllow: !dangerous && !!this.permissions,
          requester: this.getScopeLabelFn?.(),
          toolCallId,
          signal,
        }),
        signal
      );
    } catch (err) {
      if (err instanceof RunCancelledError) return cancelledResult;
      throw err;
    }

    const decision = normalizeAnswer(answer);
    if (decision.decision === 'deny') {
      return {
        approved: false,
        reason: dangerous
          ? `User denied permission to execute potentially destructive command: "${command}". Reasons: ${check.reasons.join('; ')}`
          : `User denied permission to run the command: "${command}"`,
      };
    }

    // "Always": never for a dangerous command (it is just allowed this once).
    if (decision.decision === 'allow_always' && !dangerous && this.permissions) {
      this.remember(command, decision.match, decision.command);
    }
    return { approved: true };
  }

  /** @deprecated Use {@link authorize}. Kept so existing callers keep working. */
  confirmIfDangerous(command: string, signal?: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
    return this.authorize(command, { signal });
  }

  private remember(command: string, match: PermissionMatch = 'exact', rule?: string): void {
    try {
      // A prefix rule must really be a prefix of this command, or it falls back to the exact command.
      if (match === 'prefix' && rule && matchesPrefix(command, rule)) {
        this.permissions!.add(rule, 'prefix');
      } else {
        this.permissions!.add(command, 'exact');
      }
    } catch {
      // Could not save (read-only home, disk full): the command still runs this once.
    }
  }
}
