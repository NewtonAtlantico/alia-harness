import { RunCancelledError, raceAbort } from '../abort.js';

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

export interface SafetyConfirmationContext {
  command: string;
  reasons: string[];
  requester?: string;
  /** Aborts if the run is cancelled while the question is open: dismiss the prompt. */
  signal?: AbortSignal;
}

export type SafetyConfirmationHandler = (
  context: SafetyConfirmationContext
) => Promise<boolean>;

export interface SafetyCheckerOptions {
  autoApprove?: boolean;
  onConfirm?: SafetyConfirmationHandler;
  getScopeLabel?: () => string | undefined;
  onAutoApprove?: (command: string) => void;
}

/**
 * Handlers are per instance (no process-wide defaults). Without `onConfirm`, a dangerous
 * command is denied rather than run unprompted.
 */
export class SafetyChecker {
  private autoApprove: boolean;
  private onConfirm?: SafetyConfirmationHandler;
  private getScopeLabelFn?: () => string | undefined;
  private onAutoApproveFn?: (command: string) => void;

  constructor(options: boolean | SafetyCheckerOptions = false) {
    if (typeof options === 'boolean') {
      this.autoApprove = options;
    } else {
      this.autoApprove = options.autoApprove ?? false;
      this.onConfirm = options.onConfirm;
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
   * Prompt user for confirmation if command is dangerous.
   * Returns true if approved, false if denied.
   */
  async confirmIfDangerous(command: string, signal?: AbortSignal): Promise<{ approved: boolean; reason?: string }> {
    const check = this.evaluateCommand(command);

    if (!check.isDangerous) {
      return { approved: true };
    }

    if (this.autoApprove) {
      this.onAutoApproveFn?.(command);
      return { approved: true };
    }

    const requester = this.getScopeLabelFn?.();
    const handler = this.onConfirm;

    if (!handler) {
      return {
        approved: false,
        reason: `Potentially destructive command detected: "${command}". Reasons: ${check.reasons.join('; ')}, but no confirmation handler is available.`,
      };
    }

    const cancelledResult = {
      approved: false,
      reason: `Cancelled by user before the command was approved: "${command}"`,
    };
    if (signal?.aborted) return cancelledResult;

    let approved: boolean;
    try {
      // The user may cancel the run while the approval card is open; never leave the run waiting on it.
      approved = await raceAbort(handler({ command, reasons: check.reasons, requester, signal }), signal);
    } catch (err) {
      if (err instanceof RunCancelledError) return cancelledResult;
      throw err;
    }

    if (!approved) {
      return {
        approved: false,
        reason: `User denied permission to execute potentially destructive command: "${command}". Reasons: ${check.reasons.join('; ')}`,
      };
    }

    return { approved: true };
  }
}
