/**
 * Integration test for the interactive @-mention preview.
 * Drives DynamicPrompt.askInteractive() through a fake TTY stdin, since a real
 * TTY cannot be scripted in CI. Run with: npx tsx scripts/tty-mentions.ts
 */
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { DynamicPrompt } from '../src/ui/prompt.js';
import { FileIndex } from '../src/ui/fileIndex.js';

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw: boolean | undefined = false;
  setRawMode(mode: boolean) {
    this.isRaw = mode;
  }
  resume() {}
}

const fakeStdin = new FakeStdin();
Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });

// We emit keypress events manually, so disable readline's real parser.
(readline as any).emitKeypressEvents = () => {};

let out = '';
const realWrite = process.stdout.write.bind(process.stdout);
(process.stdout as any).write = (chunk: any) => {
  out += chunk.toString();
  return true;
};

const log = (...args: any[]) => process.stderr.write(args.join(' ') + '\n');

const idx = new FileIndex(process.cwd(), 0);
const dp = new DynamicPrompt('user > ', idx);

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) log(`  ✔ ${name}`);
  else {
    failures++;
    log(`  ✘ ${name} ${extra}`);
  }
}

function press(ch?: string, name?: string, extra: Record<string, any> = {}) {
  fakeStdin.emit('keypress', ch, { name: name ?? ch, ctrl: false, meta: false, ...extra });
}
function type(text: string) {
  for (const ch of text) press(ch);
}

/** Starts an ask() and resets the captured output. Returns the pending promise. */
function begin(): Promise<string> {
  const pending = dp.ask();
  out = '';
  return pending;
}

async function main() {
  log('\n=== @ triggers file preview ===');
  let pending = begin();
  type('@');
  check('file preview box appears on @', out.includes('Files'));
  check('preview lists workspace files', out.includes('README.md') || out.includes('package.json'));
  press(undefined, 'return');
  await pending;

  log('\n=== filtering + Tab insertion ===');
  pending = begin();
  type('@read');
  check('filters to README.md', out.includes('README.md'));
  check('filters to readFile.ts', out.includes('readFile.ts'));
  out = '';
  press(undefined, 'tab');
  check('insertion auto-hides preview (complete file path)', !out.includes('Files'));
  press(undefined, 'return');
  check('Tab inserts top match', (await pending) === '@README.md');

  log('\n=== arrow navigation + Enter insertion ===');
  pending = begin();
  type('@read');
  press(undefined, 'down');
  press(undefined, 'return'); // confirms highlighted entry (2nd match)
  press(undefined, 'return'); // then submits
  check('Enter confirms navigated entry', (await pending) === '@src/tools/readFile.ts');

  log('\n=== directory drill-down ===');
  pending = begin();
  type('@src/to');
  press(undefined, 'tab'); // inserts '@src/tools/' (dir) and keeps menu open
  check('dir insert keeps children preview', out.includes('readFile.ts') && out.includes('grepSearch.ts'));
  press(undefined, 'return');
  press(undefined, 'return');
  check('submitted mention is the directory', (await pending) === '@src/tools/');

  log('\n=== Esc dismisses preview ===');
  pending = begin();
  type('@rea');
  check('preview shown before Esc', out.includes('Files'));
  out = '';
  press(undefined, 'escape');
  check('preview hidden after Esc', !out.includes('Files'));
  press(undefined, 'return');
  check('Enter after Esc submits raw text', (await pending) === '@rea');

  log('\n=== emails do not trigger preview ===');
  pending = begin();
  type('mail me at john@example.com');
  check('no file preview for emails', !out.includes('Files'));
  press(undefined, 'return');
  check('email text submitted intact', (await pending) === 'mail me at john@example.com');

  log('\n=== multiple mentions in one prompt ===');
  pending = begin();
  type('compare @README.md and @src/tools/readFile.ts');
  check('mention after whitespace stays active', out.includes('Files'));
  press(undefined, 'return');
  check('multi-mention prompt submitted intact', (await pending) === 'compare @README.md and @src/tools/readFile.ts');

  log('\n=== slash commands still work ===');
  pending = begin();
  type('/mo');
  check('slash preview still renders', out.includes('Slash Commands'));
  press(undefined, 'tab');
  press(undefined, 'return');
  check('slash Tab completes', (await pending) === '/models');

  log('\n=== Ctrl+C clears buffer ===');
  pending = begin();
  type('hello');
  press('c', 'c', { ctrl: true });
  press(undefined, 'return');
  check('Ctrl+C clears, Enter submits empty', (await pending) === '');

  log('\n=== history recall ===');
  pending = begin();
  press(undefined, 'up');
  press(undefined, 'return');
  const recalled = await pending;
  check('up-arrow recalls last submitted input', recalled === '/models', `got "${recalled}"`);

  (process.stdout as any).write = realWrite;
  log(failures === 0 ? '\nALL TTY TESTS PASSED ✅' : `\n${failures} TTY FAILURES ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
