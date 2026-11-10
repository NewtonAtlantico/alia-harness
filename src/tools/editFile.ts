import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './types.js';

interface EditFileArgs {
  path: string;
  target: string;
  replacement: string;
  replace_all?: boolean;
}

export const editFileTool: ToolDefinition<EditFileArgs> = {
  name: 'edit_file',
  description:
    'Surgically modifies a file by searching for an exact target text string and replacing it with replacement text. Target must match existing text in the file.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to edit (relative or absolute).',
      },
      target: {
        type: 'string',
        description: 'The exact string in the file to be replaced.',
      },
      replacement: {
        type: 'string',
        description: 'The new replacement string.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Whether to replace all occurrences of target (default: false, replaces first match).',
      },
    },
    required: ['path', 'target', 'replacement'],
  },
  execute: async (args, context) => {
    try {
      if (!args.path) return 'Error: Parameter "path" is required.';
      if (args.target === undefined || args.target === null) return 'Error: Parameter "target" is required.';
      if (args.replacement === undefined || args.replacement === null) return 'Error: Parameter "replacement" is required.';

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

      const content = fs.readFileSync(resolvedPath, 'utf-8');

      if (!content.includes(args.target)) {
        return `Error: Target string not found in "${args.path}". Verify line breaks and whitespace by reading the file first.`;
      }

      let newContent: string;
      let count = 0;

      if (args.replace_all) {
        count = content.split(args.target).length - 1;
        newContent = content.replaceAll(args.target, args.replacement);
      } else {
        count = 1;
        newContent = content.replace(args.target, args.replacement);
      }

      fs.writeFileSync(resolvedPath, newContent, 'utf-8');
      return `Successfully replaced ${count} occurrence(s) in "${args.path}".`;
    } catch (err: any) {
      return `Error editing file "${args.path}": ${err.message}`;
    }
  },
};
