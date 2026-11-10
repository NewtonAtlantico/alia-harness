import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './types.js';

interface EditOperation {
  target: string;
  replacement: string;
  replace_all?: boolean;
}

interface EditFileArgs {
  path: string;
  target?: string;
  replacement?: string;
  replace_all?: boolean;
  edits?: EditOperation[];
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function lineNumbersOf(haystack: string, needle: string, limit: number): number[] {
  const lines: number[] = [];
  let searchFrom = 0;
  while (lines.length < limit) {
    const index = haystack.indexOf(needle, searchFrom);
    if (index === -1) break;
    lines.push(haystack.slice(0, index).split('\n').length);
    searchFrom = index + needle.length;
  }
  return lines;
}

function lineNumberAt(haystack: string, index: number): number {
  return haystack.slice(0, index).split('\n').length;
}

export const editFileTool: ToolDefinition<EditFileArgs> = {
  name: 'edit_file',
  description:
    'Surgically modifies a file by replacing exact target strings. Each target must match exactly once in the file; ambiguous targets that match multiple times are rejected (include surrounding context to make the target unique, or set replace_all: true). Accepts either a single target/replacement pair or an "edits" array of multiple changes applied atomically (all-or-nothing: if any edit fails validation, none are written).',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to edit (relative or absolute).',
      },
      target: {
        type: 'string',
        description: 'The exact string in the file to be replaced. Must be unique in the file unless replace_all is true.',
      },
      replacement: {
        type: 'string',
        description: 'The new replacement text.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Whether to replace all occurrences of target (default: false, target must match exactly once).',
      },
      edits: {
        type: 'array',
        description:
          'Optional list of edits to apply atomically, in order. Use this instead of target/replacement when making multiple changes to the same file in one call. If any edit fails validation, no edits are applied.',
        items: {
          type: 'object',
          properties: {
            target: { type: 'string', description: 'Exact text to replace (must be unique unless replace_all is true).' },
            replacement: { type: 'string', description: 'Replacement text.' },
            replace_all: { type: 'boolean', description: 'Replace every occurrence (default: false).' },
          },
          required: ['target', 'replacement'],
        },
      },
    },
    required: ['path'],
  },
  execute: async (args, context) => {
    try {
      if (!args.path) return 'Error: Parameter "path" is required.';

      // Normalize arguments: either a single target/replacement pair, or an "edits" array.
      let operations: EditOperation[];
      if (Array.isArray(args.edits)) {
        if (args.target !== undefined || args.replacement !== undefined) {
          return 'Error: Provide either "target"/"replacement" or "edits", not both.';
        }
        if (args.edits.length === 0) {
          return 'Error: Parameter "edits" must contain at least one edit.';
        }
        for (const [i, op] of args.edits.entries()) {
          if (!op || typeof op !== 'object' || typeof op.target !== 'string' || typeof op.replacement !== 'string') {
            return `Error: edits[${i}] must be an object with string "target" and "replacement" properties.`;
          }
          if (op.target.length === 0) {
            return `Error: edits[${i}].target must be a non-empty string.`;
          }
        }
        operations = args.edits;
      } else {
        if (args.target === undefined || args.target === null) return 'Error: Parameter "target" is required.';
        if (args.replacement === undefined || args.replacement === null) return 'Error: Parameter "replacement" is required.';
        if (typeof args.target !== 'string' || typeof args.replacement !== 'string') {
          return 'Error: "target" and "replacement" must be strings.';
        }
        if (args.target.length === 0) {
          return 'Error: Parameter "target" must be a non-empty string.';
        }
        operations = [{ target: args.target, replacement: args.replacement, replace_all: args.replace_all }];
      }

      const resolvedPath = path.isAbsolute(args.path)
        ? args.path
        : path.resolve(context.workingDirectory, args.path);

      if (!fs.existsSync(resolvedPath)) {
        return `Error: File "${args.path}" does not exist. Use write_file to create new files.`;
      }

      const stat = fs.statSync(resolvedPath);
      if (stat.isDirectory()) {
        return `Error: Path "${args.path}" is a directory.`;
      }

      let content = fs.readFileSync(resolvedPath, 'utf-8');
      const applied: string[] = [];

      // Validate and apply every operation against the evolving content.
      // Nothing is written to disk until all operations succeed (all-or-nothing).
      for (const [i, op] of operations.entries()) {
        const prefix = operations.length > 1 ? `edits[${i}]` : 'target';
        const abortNote = operations.length > 1 ? ' No edits were applied (all-or-nothing).' : '';

        const occurrences = countOccurrences(content, op.target);
        if (occurrences === 0) {
          return `Error: ${prefix} not found in "${args.path}".${abortNote} Verify exact text, line breaks, and whitespace by reading the file first.`;
        }

        if (!op.replace_all && occurrences > 1) {
          const locations = lineNumbersOf(content, op.target, 5).join(', ');
          return `Error: ${prefix} is ambiguous — found ${occurrences} occurrences in "${args.path}" (first at line(s): ${locations}).${abortNote} Provide a longer target that includes surrounding context to make it unique, or set replace_all: true to replace every occurrence.`;
        }

        const firstIndex = content.indexOf(op.target);
        const line = lineNumberAt(content, firstIndex);

        if (op.replace_all) {
          content = content.split(op.target).join(op.replacement);
          applied.push(`${prefix}: replaced ${occurrences} occurrence(s)`);
        } else {
          content = content.slice(0, firstIndex) + op.replacement + content.slice(firstIndex + op.target.length);
          applied.push(`${prefix}: replaced 1 occurrence at line ${line}`);
        }
      }

      fs.writeFileSync(resolvedPath, content, 'utf-8');

      if (operations.length === 1) {
        return `Successfully edited "${args.path}" — ${applied[0]}.`;
      }
      return `Successfully applied ${operations.length} edits to "${args.path}" (all-or-nothing):\n` +
        applied.map((entry) => `- ${entry}`).join('\n');
    } catch (err: any) {
      return `Error editing file "${args.path}": ${err.message}`;
    }
  },
};
