import { exec } from 'node:child_process';
import os from 'node:os';
import { ToolDefinition } from './types.js';

interface RunBashArgs {
  command: string;
  timeout_ms?: number;
}

export const runBashTool: ToolDefinition<RunBashArgs> = {
  name: 'run_bash',
  description:
    'Executes a shell command in the local workspace terminal. Use this to run git commands, build scripts, tests, inspect directories, etc.',
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
    const isWindows = os.platform() === 'win32';
    const shell = isWindows ? 'powershell.exe' : '/bin/bash';

    return new Promise<string>((resolve) => {
      exec(
        trimmedCommand,
        {
          cwd: context.workingDirectory,
          timeout,
          shell,
          maxBuffer: 10 * 1024 * 1024, // 10MB buffer limit
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
