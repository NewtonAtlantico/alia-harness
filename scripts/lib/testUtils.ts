/** Runs fn with console/stdout output (spinner, tool previews, info lines) swallowed. */
export async function quiet<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const write = process.stdout.write;
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await fn();
  } finally {
    console.log = log;
    process.stdout.write = write;
  }
}
