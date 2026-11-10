import { exec, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ToolDefinition } from './types.js';

interface RunBashArgs {
  command: string;
  timeout_ms?: number;
}

interface ShellInfo {
  /** Executable passed to Node's `shell` option. */
  shell: string;
  /** Human-readable label reported to the model when a command fails. */
  label: string;
}

let cachedShell: ShellInfo | null = null;

/**
 * WSL launcher stubs masquerading as bash (System32/WindowsApps). They run inside a
 * separate Linux filesystem, so they are NOT suitable as the workspace shell.
 */
function isWslBashStub(candidate: string): boolean {
  return /\\(system32|windowsapps)\\bash\.exe$/i.test(candidate);
}

/**
 * Finds a real POSIX shell on Windows, preferring Git Bash so that standard POSIX
 * syntax (&&, $(...), pipes, rm -rf, etc.) works identically across platforms.
 */
function findPosixShellOnWindows(): ShellInfo | null {
  // 1. Well-known Git Bash install locations.
  const candidates = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Git', 'bin', 'bash.exe') : null,
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return { shell: candidate, label: 'bash (POSIX, via Git Bash)' };
    }
  }

  // 2. Derive Git Bash from the git.exe found on PATH (e.g. <...>\Git\cmd\git.exe -> <...>\Git\bin\bash.exe).
  try {
    const gitPath = execSync('where git', { shell: 'cmd.exe', stdio: 'pipe', windowsHide: true })
      .toString()
      .split(/\r?\n/)[0]
      ?.trim();
    if (gitPath) {
      const gitBash = path.join(path.dirname(path.dirname(gitPath)), 'bin', 'bash.exe');
      if (fs.existsSync(gitBash)) {
        return { shell: gitBash, label: 'bash (POSIX, via Git Bash)' };
      }
    }
  } catch {
    // git not on PATH
  }

  // 3. Any bash on PATH, excluding the WSL launcher stubs.
  try {
    const bashPaths = execSync('where bash', { shell: 'cmd.exe', stdio: 'pipe', windowsHide: true })
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const bashPath = bashPaths.find((candidate) => !isWslBashStub(candidate) && fs.existsSync(candidate));
    if (bashPath) {
      return { shell: bashPath, label: 'bash (POSIX)' };
    }
  } catch {
    // bash not on PATH
  }

  return null;
}

function resolveShell(): ShellInfo {
  if (cachedShell) return cachedShell;

  if (os.platform() === 'win32') {
    cachedShell =
      findPosixShellOnWindows() ?? {
        shell: 'powershell.exe',
        label: 'Windows PowerShell (NOT POSIX-compatible: use ";" instead of "&&")',
      };
  } else {
    cachedShell = { shell: '/bin/bash', label: 'bash (POSIX)' };
  }

  return cachedShell;
}

export const runBashTool: ToolDefinition<RunBashArgs> = {
  name: 'run_bash',
  description:
    'Executes a shell command in the local workspace terminal. Uses a POSIX bash shell (Git Bash on Windows when available, PowerShell only as a fallback) so standard syntax like &&, pipes, and $() works everywhere. Use this to run git commands, build scripts, tests, inspect directories, etc.',
  parameters: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The shell command to execute.',
      },
      timeout_ms: {
        type: 'integer',
        description: 'Optional execution timeout in milliseconds (default: 30000).',
      },
    },
    required: ['command'],
  },
  execute: async (args, context) => {
    if (!args.command || typeof args.command !== 'string') {
      return 'Error: Parameter "command" is required.';
    }

    const trimmedCommand = args.command.trim();

    // Human-in-the-loop safety gate
    const safetyCheck = await context.safetyChecker.confirmIfDangerous(trimmedCommand);
    if (!safetyCheck.approved) {
      return safetyCheck.reason || 'Command execution cancelled by user.';
    }

    const timeout = args.timeout_ms && args.timeout_ms > 0 ? args.timeout_ms : 30000;
    const { shell, label } = resolveShell();

    return new Promise<string>((resolve) => {
      exec(
        trimmedCommand,
        {
          cwd: context.workingDirectory,
          timeout,
          shell,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer limit
          windowsHide: true,
          env: {
            ...process.env,
            FORCE_COLOR: '0', // Plain text output for LLM
          },
        },
        (error, stdout, stderr) => {
          let output = '';

          const exitCode = error && typeof error.code === 'number' ? error.code : (error ? 1 : 0);

          if (error && error.killed) {
            output += `[Execution timed out after ${timeout}ms]\n`;
          }

          if (stdout && stdout.trim().length > 0) {
            output += stdout;
          }

          if (stderr && stderr.trim().length > 0) {
            output += (output ? '\n[STDERR]:\n' : '[STDERR]:\n') + stderr;
          }

          // On failure, tell the model which shell ran the command so it can adapt its syntax.
          if (exitCode !== 0) {
            output += `\n[Shell: ${label}]`;
          }

          if (!output.trim()) {
            output = `Command executed successfully with no output (exit code: ${exitCode}).`;
          } else {
            output = `[Exit Code: ${exitCode}]\n` + output;
          }

          const { output: truncatedOutput } = context.contextManager.truncateToolOutput(output);
          resolve(truncatedOutput);
        }
      );
    });
  },
};
