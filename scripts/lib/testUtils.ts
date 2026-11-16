/** Runs fn with console/stdout output (spinner, tool previews, info lines) swallowed. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  return (await capture(fn)).result;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '').replace(/\r/g, '');

/**
 * Like quiet(), but returns what was printed: one entry per console.log call (ANSI codes
 * stripped, may contain newlines) plus raw stdout writes joined in `stdout`.
 */
export async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[]; text: string }> {
  const log = console.log;
  const write = process.stdout.write;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(stripAnsi(args.map(String).join(' ')));
  };
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    const result = await fn();
    return { result, lines, text: lines.join('\n') };
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}
