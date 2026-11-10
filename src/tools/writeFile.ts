import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './types.js';

interface WriteFileArgs {
  path: string;
  content: string;
}

export const writeFileTool: ToolDefinition<WriteFileArgs> = {
  name: 'write_file',
  description:
    'Writes or overwrites text content to a file at the specified path. Automatically creates parent directories if they do not exist.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'The path of the file to write (relative or absolute).',
      },
      content: {
        type: 'string',
        description: 'The complete text content to write into the file.',
      },
    },
    required: ['path', 'content'],
  },
  execute: async (args, context) => {
    try {
      if (!args.path) {
        return 'Error: Parameter "path" is required.';
      }
      if (args.content === undefined || args.content === null) {
        return 'Error: Parameter "content" is required.';
      }

      const resolvedPath = path.isAbsolute(args.path)
        ? args.path
        : path.resolve(context.workingDirectory, args.path);

      const parentDir = path.dirname(resolvedPath);
      if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const existed = fs.existsSync(resolvedPath);
      fs.writeFileSync(resolvedPath, args.content, 'utf-8');

      const byteSize = Buffer.byteLength(args.content, 'utf-8');
      const action = existed ? 'overwritten' : 'created';
      return `Successfully ${action} file "${args.path}" (${byteSize} bytes written).`;
    } catch (err: any) {
      return `Error writing file "${args.path}": ${err.message}`;
    }
  },
};
