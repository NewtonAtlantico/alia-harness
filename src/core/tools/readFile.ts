import fs from 'node:fs';
import path from 'node:path';
import { ToolDefinition } from './types.js';
import { detectBinaryFile } from './fileUtils.js';
import { describePages, documentKind, readDocument } from '../documents/readDocument.js';

interface ReadFileArgs {
  path: string;
  start_line?: number;
  line_count?: number;
  pages?: string | number;
}

export const readFileTool: ToolDefinition<ReadFileArgs> = {
  name: 'read_file',
  description:
    'Reads text content from a given file path. Can optionally read a specific line range. Also reads PDF documents as text, with [p. N] page markers: a long document is returned in chunks, so use "pages" (e.g. "7-12") to continue where the previous result stopped. Audio/video and scanned PDFs cannot be read. Other binary files are rejected (detected by extension or NUL bytes).',
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
      pages: {
        type: 'string',
        description: 'For PDF documents: which pages to read, e.g. "3", "3-5", "1,4-6" or "7-". Default: from the start.',
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

      // PDFs (and recordings, which get a clear "send a transcript" error) are documents, not text files.
      if (documentKind(resolvedPath)) {
        const limits = context.contextManager.getLimits();
        // Sized to what one tool result may hold, so the middle of a document is never silently dropped.
        const doc = await readDocument(resolvedPath, {
          pages: args.pages,
          maxChars: limits.maxToolOutputChars - 700,
          maxLines: limits.maxToolOutputLines - 8,
        });
        if (!doc.ok) return `Error: ${doc.error}`;

        const notes = doc.warnings.map((w) => `[Note: ${w}]`);
        if (doc.nextPage !== undefined) {
          const span = Math.max(1, doc.pagesShown.length);
          const last = Math.min(doc.totalPages, doc.nextPage + span - 1);
          notes.push(
            `[Showing pages ${describePages(doc.pagesShown)} of ${doc.totalPages}. Continue with pages: "${doc.nextPage}-${last}".]`
          );
        } else if (doc.pagesShown.length < doc.totalPages) {
          notes.push(`[Showing pages ${describePages(doc.pagesShown)} of ${doc.totalPages}.]`);
        }
        return [`--- Document: ${args.path} (PDF, ${doc.totalPages} page${doc.totalPages === 1 ? '' : 's'}) ---`, doc.text, ...notes].join('\n');
      }

      // Reject binary files instead of dumping unreadable garbage into the context window.
      const binaryCheck = detectBinaryFile(resolvedPath);
      if (binaryCheck.binary) {
        return `Error: File "${args.path}" appears to be a binary file (detected via ${binaryCheck.reason}; ${stat.size} bytes). read_file only supports text files.`;
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
