import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './types.js';

interface GrepSearchArgs {
  query: string;
  path?: string;
  case_sensitive?: boolean;
  max_results?: number;
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.cache', '.gemini']);
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.pdf', '.zip', '.tar', '.gz', '.exe', '.dll', '.bin',
]);

export const grepSearchTool: ToolDefinition<GrepSearchArgs> = {
  name: 'grep_search',
  description:
    'Searches for text or regex across files in the workspace. Returns matching file paths, line numbers, and matching lines.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'The text or regex pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'Directory path to search in (default: "." for entire workspace).',
      },
      case_sensitive: {
        type: 'boolean',
        description: 'Whether search is case-sensitive (default: false).',
      },
      max_results: {
        type: 'integer',
        description: 'Maximum number of match lines to return (default: 50).',
      },
    },
    required: ['query'],
  },
  execute: async (args, context) => {
    try {
      if (!args.query) return 'Error: Parameter "query" is required.';

      const startDir = path.isAbsolute(args.path || '.')
        ? args.path || '.'
        : path.resolve(context.workingDirectory, args.path || '.');

      if (!fs.existsSync(startDir)) {
        return `Error: Directory "${args.path || '.'}" does not exist.`;
      }

      const flags = args.case_sensitive ? 'g' : 'gi';
      let regex: RegExp;
      try {
        regex = new RegExp(args.query, flags);
      } catch {
        // Fallback to literal search if invalid regex
        const escaped = args.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        regex = new RegExp(escaped, flags);
      }

      const maxResults = Math.min(Math.max(args.max_results ?? 50, 1), 200);
      const matches: string[] = [];

      function searchDirectory(dir: string) {
        if (matches.length >= maxResults) return;

        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }

        for (const entry of entries) {
          if (matches.length >= maxResults) break;

          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            if (!IGNORED_DIRS.has(entry.name)) {
              searchDirectory(fullPath);
            }
          } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (BINARY_EXTENSIONS.has(ext)) continue;

            try {
              const fileContent = fs.readFileSync(fullPath, 'utf-8');
              const lines = fileContent.split('\n');
              const relPath = path.relative(context.workingDirectory, fullPath);

              for (let i = 0; i < lines.length; i++) {
                if (matches.length >= maxResults) break;
                const line = lines[i];
                regex.lastIndex = 0;
                if (regex.test(line)) {
                  matches.push(`${relPath}:${i + 1}: ${line.trim()}`);
                }
              }
            } catch {
              // Ignore binary or unreadable files
            }
          }
        }
      }

      searchDirectory(startDir);

      if (matches.length === 0) {
        return `No matches found for query "${args.query}".`;
      }

      const header = `Found ${matches.length} matches for "${args.query}":\n`;
      const resultText = header + matches.join('\n');
      const { output } = context.contextManager.truncateToolOutput(resultText);
      return output;
    } catch (err: any) {
      return `Error performing grep search: ${err.message}`;
    }
  },
};
