import { FileIndex } from '../src/ui/fileIndex.js';
import { resolveFileMentions, hasFileMentions } from '../src/context/fileMentions.js';
import { DynamicPrompt } from '../src/ui/prompt.js';
import pc from 'picocolors';

const cwd = process.cwd();
let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

console.log('\n=== FileIndex ===');
const idx = new FileIndex(cwd, 0);
const empty = idx.search('');
console.log(`  total entries: ${empty.total}`);
check('indexes workspace files', empty.total > 10);
check(
  'no node_modules/.git/binary entries',
  empty.matches.concat([]).every(() => true) // checked via sample below
);
const all = idx.search('', 10000).matches;
check(
  'ignores noise dirs & binaries',
  !all.some((e) => e.path.includes('node_modules/') || e.path.includes('.git/') || e.path.endsWith('.png'))
);

const r1 = idx.search('prompt');
console.log(`  search('prompt') -> ${r1.matches.map((m) => m.path).join(', ')}`);
check('finds prompt.ts by basename', r1.matches.some((e) => e.path === 'src/ui/prompt.ts'));

const r2 = idx.search('src/to');
console.log(`  search('src/to') -> ${r2.matches.slice(0, 3).map((m) => m.path).join(', ')}`);
check('prefix path search ranks src/tools first', r2.matches[0]?.path.startsWith('src/to') === true);
check('directories are indexed', r2.matches.some((e) => e.isDir && e.path === 'src/tools'));

const r3 = idx.search('agtlp');
console.log(`  search('agtlp') (fuzzy) -> ${r3.matches.slice(0, 3).map((m) => m.path).join(', ')}`);
check('fuzzy subsequence matches agentLoop', r3.matches.some((e) => e.path === 'src/agent/agentLoop.ts'));

const r4 = idx.search('README');
check('basename match for README', r4.matches.some((e) => e.path === 'README.md'));

check('exactFileMatch full path', idx.exactFileMatch('src/index.ts') === true);
check('exactFileMatch dir path is false', idx.exactFileMatch('src') === false);
check('exactFileMatch bogus is false', idx.exactFileMatch('nope.xyz') === false);

console.log('\n=== resolveFileMentions ===');
const res1 = resolveFileMentions('Review @src/tools/types.ts and @README.md please', cwd);
check('resolves two file mentions', res1.attachments.length === 2);
check('errors empty', res1.errors.length === 0, JSON.stringify(res1.errors));
check(
  'prompt embeds file contents',
  res1.prompt.includes('<file_attachments>') &&
    res1.prompt.includes('<file path="src/tools/types.ts"') &&
    res1.prompt.includes('interface ToolDefinition')
);
check('original text preserved', res1.prompt.startsWith('Review @src/tools/types.ts and @README.md please'));

const res2 = resolveFileMentions('What is in @src/tools/?', cwd);
check('directory mention attaches listing', res2.attachments.length === 1 && res2.attachments[0].isDir);
check(
  'listing includes known files',
  res2.prompt.includes('readFile.ts') && res2.prompt.includes('<directory path="src/tools"')
);

const res3 = resolveFileMentions('fix @does/not/exist.ts', cwd);
check('missing file -> error, prompt unchanged', res3.errors.length === 1 && res3.prompt === 'fix @does/not/exist.ts');

const res4 = resolveFileMentions('email me at john@example.com about @README.md', cwd);
check('emails are not mentions', res4.attachments.length === 1 && res4.attachments[0].mention === '@README.md');

const res5 = resolveFileMentions('compare @README.md and @README.md.', cwd);
check('dedupes repeated mentions (incl. trailing period)', res5.attachments.length === 1);

const res6 = resolveFileMentions('no mentions here', cwd);
check('no mentions -> prompt unchanged', res6.prompt === 'no mentions here' && res6.attachments.length === 0);

check('hasFileMentions true', hasFileMentions('see @src/index.ts') === true);
check('hasFileMentions false for email', hasFileMentions('a@b.com') === false);

console.log('\n=== preview box geometry ===');
const dp = new DynamicPrompt(undefined as any, idx);
const anyDp = dp as any;
const box = anyDp.buildFilePreviewBox(empty.matches, 0, empty.total + 100) as string[];
const stripped = (s: string) => pc.stripColorsOrUndefined ? s : s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
box.forEach((line, i) => {
  const visible = stripped(line).replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').length;
  if (visible !== 68) {
    failures++;
    console.log(`  ✘ box line ${i} visible width ${visible} != 68`);
  }
});
console.log(`  box lines: ${box.length}`);
check('header says Files', stripped(box[0]).includes(' Files '));
check('overflow row rendered', box.some((l) => l.includes('more matches')));
check('footer hints Esc', box[box.length - 1].includes('Esc'));
const noMatch = anyDp.buildFilePreviewBox([], 0, 0) as string[];
check('no-match box renders', noMatch.length > 0 && noMatch.some((l) => l.includes('No matching files')));

console.log(failures === 0 ? '\nALL PASSED ✅' : `\n${failures} FAILURES ❌`);
process.exit(failures === 0 ? 0 : 1);
