import fs from 'node:fs';
import path from 'node:path';

/**
 * Directories that are noise for agent exploration (build artifacts, VCS metadata,
 * huge dependency trees). Shared by list_files and grep_search.
 */
export const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.cache',
  '.gemini',
  '.next',
  '.turbo',
  'coverage',
]);

/**
 * File extensions that (almost) always indicate binary content.
 * Extensions not listed here are handled by NUL-byte content detection.
 */
export const BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.bmp', '.webp', '.svgz', '.tif', '.tiff', '.psd', '.ai',
  // Fonts
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  // Audio / video
  '.mp3', '.wav', '.ogg', '.flac', '.mp4', '.webm', '.mov', '.avi', '.mkv',
  // Archives
  '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar',
  // Binary document formats
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  // Executables / native libraries / bytecode
  '.exe', '.dll', '.bin', '.so', '.dylib', '.o', '.obj', '.lib', '.a', '.class', '.jar', '.wasm', '.node',
  // Databases
  '.db', '.sqlite', '.sqlite3', '.mdb',
  // Installers / disk images
  '.msi', '.apk', '.ipa', '.dmg', '.iso', '.img', '.deb', '.rpm',
  // Python bytecode
  '.pyc', '.pyo',
]);

/**
 * Reads the first `size` bytes of a file without loading the entire file into memory.
 * Returns null if the file cannot be read.
 */
export function readFirstChunk(filePath: string, size = 8192): Buffer | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buffer = Buffer.alloc(size);
    const bytesRead = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Ignore close errors
      }
    }
  }
}

/**
 * Heuristic binary file detection (same approach git/grep use):
 * 1. Known binary file extensions, or
 * 2. NUL bytes within the first 8KB of content (covers unknown/absent extensions).
 */
export function detectBinaryFile(filePath: string): { binary: boolean; reason?: string } {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) {
    return { binary: true, reason: `extension "${ext}"` };
  }

  const chunk = readFirstChunk(filePath);
  if (chunk && chunk.length > 0 && chunk.includes(0)) {
    return { binary: true, reason: 'NUL bytes found in content' };
  }

  return { binary: false };
}
