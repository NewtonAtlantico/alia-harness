import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './types.js';

interface ListFilesArgs {
  path?: string;
  max_depth?: number;
}

const IGNORED_NAMES = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.gemini']);

export const listFilesTool: ToolDefinition<ListFilesArgs> = {
  name: 'list_files',
  description:
    'Lists files and directories in a directory tree, ignoring heavy directories like node_modules and .git.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path to list (defaults to current working directory ".").',
      },
      max_depth: {
        type: 'integer',
        description: 'Maximum depth for recursive listing (default: 2, max: 5).',
      },
    },
  },
  execute: async (args, context) => {
    try {
      const relPath = args.path || '.';
      const targetDir = path.isAbsolute(relPath)
        ? relPath
        : path.resolve(context.workingDirectory, relPath);

      if (!fs.existsSync(targetDir)) {
        return `Error: Directory "${relPath}" does not exist.`;
      }

      const stat = fs.statSync(targetDir);
      if (!stat.isDirectory()) {
        return `Error: Path "${relPath}" is a file, not a directory. Use read_file to inspect it.`;
      }

      const maxDepth = Math.min(Math.max(args.max_depth ?? 2, 1), 5);
      const results: string[] = [];

      function walk(currentDir: string, depth: number, prefix: string) {
        if (depth > maxDepth) return;

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (e: any) {
          results.push(`${prefix}[Permission denied: ${e.message}]`);
          return;
        }

        // Sort directories first, then alphabetical
        entries.sort((a, b) => {
          if (a.isDirectory() && !b.isDirectory()) return -1;
          if (!a.isDirectory() && b.isDirectory()) return 1;
          return a.name.localeCompare(b.name);
        });

        for (const entry of entries) {
          if (IGNORED_NAMES.has(entry.name)) {
            continue;
          }

          const isDir = entry.isDirectory();
          const display = `${prefix}${isDir ? '📁 ' : '📄 '}${entry.name}${isDir ? '/' : ''}`;
          results.push(display);

          if (isDir && depth < maxDepth) {
            walk(path.join(currentDir, entry.name), depth + 1, prefix + '  ');
          }
        }
      }

      results.push(`📁 ${path.relative(context.workingDirectory, targetDir) || '.'}/`);
      walk(targetDir, 1, '  ');

      const fullOutput = results.join('\n');
      const { output } = context.contextManager.truncateToolOutput(fullOutput);
      return output;
    } catch (err: any) {
      return `Error listing directory: ${err.message}`;
    }
  },
};
