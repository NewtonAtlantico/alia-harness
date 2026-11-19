import type { CommandProbe } from 'alia-harness/core';
import fs from 'node:fs';

/**
 * A way for the end-to-end tests to say "a GitHub remote is there and `gh` is signed in" without the machine having one.
 * Only when the app runs under test (`ALIA_DESKTOP_TEST=1`) and a file named by `ALIA_TEST_ISSUES_FILE` says `ready`; read at
 * every probe, so a test can connect and disconnect between two attempts. In a real run this returns nothing and core
 * probes git, gh and glab for real.
 */
export function testIssueProbe(): CommandProbe | undefined {
  const file = process.env.ALIA_DESKTOP_TEST === '1' ? process.env.ALIA_TEST_ISSUES_FILE : undefined;
  if (!file) return undefined;
  const ready = () => {
    try {
      return fs.readFileSync(file, 'utf8').trim() === 'ready';
    } catch {
      return false;
    }
  };
  const ok = (stdout = '') => ({ code: 0, stdout, missing: false, timedOut: false });
  const refused = { code: 1, stdout: '', missing: false, timedOut: false };
  return async (command, args) => {
    if (command === 'git') return ready() ? ok('https://github.com/acme/portal.git\n') : refused;
    if (command === 'gh') return ready() ? ok() : refused;
    return { code: null, stdout: '', missing: true, timedOut: false };
  };
}
