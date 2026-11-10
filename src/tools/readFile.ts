import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './types.js';

interface ReadFileArgs {
  path: string;
  start_line?: number;
  line_count?: number;
}

export const readFileTool: ToolDefinition<ReadFileArgs> = {
  name: 'read_file',
  description: 'Reads text content from a given file path. Can optionally read a specific line range.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to read (relative to the current workspace or absolute).',
      },
      start_line: {
        type: 'integer',
        description: 'Optional 1-based line number to start reading from.',
      },
      line_count: {
        type: 'integer',
        description: 'Optional number of lines to read starting from start_line.',
      },
    },
    required: ['path'],
  },
  execute: async (args, context) => {
    try {
      if (!args.path) {
        return 'Error: Parameter "path" is required.';
      }

      const resolvedPath = path.isAbsolute(args.path)
        ? args.path
        : path.resolve(context.workingDirectory, args.path);

      if (!fs.existsSync(resolvedPath)) {
        return `Error: File not found at path "${args.path}" (resolved: "${resolvedPath}")`;
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        return `Error: Path "${args.path}" is a directory, not a file. Use list_files or run_bash to inspect directory contents.`;
      }

      const content = fs.readFileSync(resolvedPath, 'utf-8');
      const lines = content.split('\n');

      let selectedLines = lines;
      let startLine = 1;

      if (args.start_line && args.start_line > 1) {
        startLine = Math.min(args.start_line, lines.length);
        const count = args.line_count && args.line_count > 0 ? args.line_count : lines.length;
        selectedLines = lines.slice(startLine - 1, startLine - 1 + count);
      } else if (args.line_count && args.line_count > 0) {
        selectedLines = lines.slice(0, args.line_count);
      }

      // Add line numbers for agent readability
      const formatted = selectedLines
        .map((line, idx) => {
          const lineNum = (startLine + idx).toString().padStart(4, ' ');
          return `${lineNum} | ${line}`;
        })
        .join('\n');

      const header = `--- File: ${args.path} (${lines.length} lines total) ---\n`;
      const fullText = header + formatted;

      const { output } = context.contextManager.truncateToolOutput(fullText);
      return output;
    } catch (err: any) {
      return `Error reading file "${args.path}": ${err.message}`;
    }
  },
};
