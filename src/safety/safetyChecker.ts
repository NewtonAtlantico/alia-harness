import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import pc from 'picocolors';

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

export class SafetyChecker {
  private autoApprove: boolean;

  constructor(autoApprove = false) {
    this.autoApprove = autoApprove;
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
   * Interactively prompt user for confirmation if command is dangerous.
   * Returns true if approved, false if denied.
   */
  async confirmIfDangerous(command: string): Promise<{ approved: boolean; reason?: string }> {
    const check = this.evaluateCommand(command);

    if (!check.isDangerous) {
      return { approved: true };
    }

    if (this.autoApprove) {
      console.log(pc.yellow(`⚠️  [Auto-Approved Dangerous Command]: ${command}`));
      return { approved: true };
    }

    console.log('\n' + pc.bgRed(pc.white(' ⚠️  SAFETY GATE: POTENTIALLY DESTRUCTIVE ACTION DETECTED ')));
    console.log(pc.red(`Command: ${pc.bold(command)}`));
    console.log(pc.yellow(`Reason(s): ${check.reasons.join(', ')}`));
    console.log(pc.cyan('The agent is requesting permission to execute this command on your machine.'));

    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(pc.bold('Do you want to allow this command? [y/N]: '));
      const trimmed = answer.trim().toLowerCase();
      const approved = trimmed === 'y' || trimmed === 'yes';

      if (!approved) {
        return {
          approved: false,
          reason: `User denied permission to execute potentially destructive command: "${command}". Reasons: ${check.reasons.join('; ')}`,
        };
      }

      return { approved: true };
    } finally {
      rl.close();
    }
  }
}
