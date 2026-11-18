import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import { resolveFileMentions, resolveFileMentionsAsync } from '../src/core/context/fileMentions.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { readFileTool } from '../src/core/tools/readFile.js';
import { isToolErrorResult } from '../src/core/tools/types.js';
import { describePages, documentKind, parsePageSpec, readDocument } from '../src/core/documents/readDocument.js';
import { FakeModel } from './lib/fakeModel.js';
import { longPdf, makePdf } from './lib/pdfFixture.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-docs-'));
const put = (name: string, content: Buffer | string) => {
  const f = path.join(tmp, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};

const report = put(
  'report.pdf',
  makePdf([
    ['Requisitos funcionais', 'O cliente deve fazer login com autenticação corporativa.', 'Instituto Atlântico'],
    ['Parceiros externos usam o portal?', 'Sim, a partir da fase 2 (ver ADR-0003).'],
    ['Integração com o ERP fica fora do MVP.', 'Dono: Newton'],
  ])
);

const ctx = (limits?: ConstructorParameters<typeof ContextManager>[0]) => ({
  workingDirectory: tmp,
  safetyChecker: new SafetyChecker(true),
  contextManager: new ContextManager(limits),
});
const read = (args: object, limits?: ConstructorParameters<typeof ContextManager>[0]) => readFileTool.execute(args as any, ctx(limits));

console.log('\n=== what counts as a document ===');
{
  check('pdf, in any case', documentKind('a.pdf') === 'pdf' && documentKind('A.PDF') === 'pdf');
  check('audio and video are recordings', ['x.mp4', 'x.MOV', 'x.mp3', 'x.m4a', 'x.wav', 'x.webm', 'x.mkv'].every((f) => documentKind(f) === 'recording'));
  check('ordinary files are not documents', documentKind('a.txt') === undefined && documentKind('a.ts') === undefined && documentKind('noext') === undefined);
  check('Office files are documents too (see test:office)', documentKind('a.docx') === 'docx' && documentKind('a.pptx') === 'pptx');
}

console.log('\n=== page selections ===');
{
  const ok = (spec: any, total = 10) => {
    const r = parsePageSpec(spec, total);
    return 'pages' in r ? r.pages.join() : `ERR:${r.error}`;
  };
  check('no selection means every page', ok(undefined, 4) === '1,2,3,4' && ok('', 4) === '1,2,3,4' && ok('  ', 4) === '1,2,3,4');
  check('a page, a range, a list, an open range', ok('3') === '3' && ok('3-5') === '3,4,5' && ok('1,4-6') === '1,4,5,6' && ok('8-') === '8,9,10');
  check('a number works too (models often send one)', ok(3) === '3');
  check('order and duplicates are tidied', ok('5,1,3-4,3') === '1,3,4,5');
  check('spaces are tolerated', ok(' 2 - 4 , 7 ') === '2,3,4,7');
  const over = parsePageSpec('8-15', 10) as any;
  check('pages beyond the end are ignored, with a warning', over.pages.join() === '8,9,10' && over.warnings[0].includes('beyond 10'));
  check('a selection entirely past the end is an error', ok('99').startsWith('ERR:') && ok('99').includes('10 pages'));
  for (const bad of ['abc', '0', '5-3', '-3', '1;2', '1..3']) check(`rejected: ${JSON.stringify(bad)}`, ok(bad).startsWith('ERR:'));
  check('describePages', describePages([1, 2, 3, 4, 5, 6]) === '1-6' && describePages([2, 4, 5]) === '2,4-5' && describePages([7]) === '7' && describePages([]) === '');
}

console.log('\n=== reading a PDF ===');
{
  const r = await readDocument(report);
  check('reads all three pages', r.ok && r.kind === 'pdf' && r.totalPages === 3 && r.pagesShown.join() === '1,2,3' && r.nextPage === undefined && r.warnings.length === 0);
  if (r.ok) {
    check('each page starts with its [p. N] marker, in order', r.text.indexOf('[p. 1]') >= 0 && r.text.indexOf('[p. 1]') < r.text.indexOf('[p. 2]') && r.text.indexOf('[p. 2]') < r.text.indexOf('[p. 3]'));
    check('Portuguese accents survive', r.text.includes('autenticação') && r.text.includes('Atlântico') && r.text.includes('Integração'));
    check('lines stay on separate lines', r.text.includes('Requisitos funcionais\nO cliente deve fazer login') && r.text.includes('Instituto Atlântico\n\n[p. 2]'));
    check('text belongs to the right page', r.text.split('[p. 2]')[1].split('[p. 3]')[0].includes('Parceiros externos') && !r.text.split('[p. 2]')[1].split('[p. 3]')[0].includes('ERP'));
  }
  const p2 = await readDocument(report, { pages: '2' });
  check('a single page, still marked with its real number', p2.ok && p2.pagesShown.join() === '2' && p2.text.startsWith('[p. 2]') && !p2.text.includes('[p. 1]') && !p2.text.includes('ERP'));
  const p23 = await readDocument(report, { pages: '2-3' });
  check('a range', p23.ok && p23.pagesShown.join() === '2,3' && p23.text.includes('[p. 3]'));
  const tail = await readDocument(report, { pages: '3-' });
  check('an open range', tail.ok && tail.pagesShown.join() === '3');
  const numeric = await readDocument(report, { pages: 1 });
  check('a numeric page argument', numeric.ok && numeric.pagesShown.join() === '1');
  const missing = await readDocument(report, { pages: '9' });
  check('a page past the end is an error that says how many there are', !missing.ok && missing.error.includes('3 pages'));
  const bad = await readDocument(report, { pages: 'x' });
  check('a malformed selection is an error that shows the accepted forms', !bad.ok && bad.error.includes('"3-5"'));
}

console.log('\n=== long documents are read in chunks, nothing silently lost ===');
{
  const long = put('long.pdf', longPdf(12, 8));
  const full = await readDocument(long);
  check('the whole thing reads fine without a budget', full.ok && full.pagesShown.length === 12);

  // Follow nextPage until the end with a small budget.
  let pages = '1-';
  const got: number[] = [];
  const texts: string[] = [];
  let hops = 0;
  while (pages && hops++ < 20) {
    const chunk = await readDocument(long, { pages, maxChars: 700 });
    if (!chunk.ok) {
      check('chunk read', false, chunk.error);
      break;
    }
    got.push(...chunk.pagesShown);
    texts.push(chunk.text);
    pages = chunk.nextPage ? `${chunk.nextPage}-` : '';
  }
  check('following nextPage visits every page exactly once, in order', got.join() === '1,2,3,4,5,6,7,8,9,10,11,12', got.join());
  check('with several chunks, each within the budget', hops > 3 && texts.every((t) => t.length <= 700));
  check('the chunks put together equal the whole document', full.ok && texts.join('\n\n') === full.text);

  const byLines = await readDocument(long, { maxLines: 20 });
  check('a line budget works the same way', byLines.ok && byLines.pagesShown.length === 2 && byLines.nextPage === 3 && byLines.text.split('\n').length <= 20, `${byLines.ok && byLines.pagesShown.join()}`);

  const oneHuge = await readDocument(put('huge-page.pdf', longPdf(3, 200)), { maxChars: 1000 });
  check('a single page over budget is cut, and says so; the next page is offered', oneHuge.ok && oneHuge.pagesShown.join() === '1' && oneHuge.nextPage === 2 && oneHuge.text.includes('page 1 cut') && oneHuge.text.length <= 1000);
}

console.log('\n=== scanned, image-only and mixed documents ===');
{
  const scan = put('scan.pdf', makePdf([null, null, null]));
  const r = await readDocument(scan);
  check('a PDF with no text layer is refused, with the reason and what to do', !r.ok && r.error.includes('scanned document') && r.error.includes('no text layer') && r.error.includes('OCR is not available'), r.ok ? 'ok' : r.error);

  const mixed = put('mixed.pdf', makePdf([['Real text on page one'], null, ['More text on page three']]));
  const m = await readDocument(mixed);
  check('a mixed document is read, and the empty page is flagged', m.ok && m.text.includes('[p. 2]\n(no text)') && m.warnings.length === 1 && m.warnings[0].includes('page 2') && m.warnings[0].includes('missing'), m.ok ? m.warnings.join('|') : m.error);

  const onlyEmpty = await readDocument(mixed, { pages: '2' });
  check('asking for just the empty page reports a scan', !onlyEmpty.ok && onlyEmpty.error.includes('scanned'));

  const later = put('late-text.pdf', makePdf([null, null, ['Text only from page three'], ['and page four']]));
  const budgeted = await readDocument(later, { maxChars: 60 });
  check('blank leading pages are not mistaken for a scan when text follows (it offers page 3 next)', budgeted.ok && budgeted.nextPage === 3 && budgeted.warnings.length === 1, budgeted.ok ? JSON.stringify(budgeted) : budgeted.error);
  const rest = await readDocument(later, { pages: '3-' });
  check('...and page 3 onward has the text', rest.ok && rest.text.includes('Text only from page three') && rest.warnings.length === 0);
}

console.log('\n=== recordings and broken files ===');
{
  const rec = await readDocument(path.join(tmp, 'kickoff.mp4'));
  check('a recording says to send a transcript (without needing the file)', !rec.ok && rec.error.includes('recording') && rec.error.includes('transcript'));
  const garbage = await readDocument(put('garbage.pdf', Buffer.from('this is not a pdf at all')));
  check('a corrupt PDF is a clear error, not an exception', !garbage.ok && garbage.error.includes('could not be parsed'), garbage.ok ? 'ok' : garbage.error);
  const empty = await readDocument(put('empty.pdf', Buffer.alloc(0)));
  check('an empty file too', !empty.ok);
  const gone = await readDocument(path.join(tmp, 'nope.pdf'));
  check('a missing file too', !gone.ok && gone.error.includes('Could not open'));
}

console.log('\n=== read_file ===');
{
  const out = await read({ path: 'report.pdf' });
  check('reads a PDF through the ordinary read_file tool', out.startsWith('--- Document: report.pdf (PDF, 3 pages) ---\n[p. 1]') && out.includes('autenticação') && !isToolErrorResult(out), out.slice(0, 120));
  check('a complete read has no "continue" hint', !out.includes('Continue with'));
  const p2 = await read({ path: 'report.pdf', pages: '2' });
  check('pages selects, and says what it showed', p2.includes('[p. 2]') && !p2.includes('[p. 1]') && p2.includes('[Showing pages 2 of 3.]'));
  check('pages may be a number', (await read({ path: 'report.pdf', pages: 3 })).includes('[p. 3]'));

  // A long document: the result fits one tool result and tells the model how to go on.
  put('long2.pdf', longPdf(30, 10));
  const first = await read({ path: 'long2.pdf' });
  check('the default tool limits (16000 chars, 250 lines) are respected without truncation', first.length <= 16000 && first.split('\n').length <= 250 && !first.includes('Truncated'), `${first.length} chars, ${first.split('\n').length} lines`);
  const hint = /Continue with pages: "(\d+)-(\d+)"/.exec(first);
  check('it ends with an exact instruction for the next call', !!hint && first.includes(`[Showing pages 1-${Number(hint![1]) - 1} of 30.`), first.split('\n').slice(-2).join('|'));
  // Following the hints covers every page, once.
  const seen: number[] = [];
  let spec: string | undefined = undefined;
  for (let i = 0; i < 40; i++) {
    const res: string = await read({ path: 'long2.pdf', pages: spec });
    seen.push(...[...res.matchAll(/^\[p\. (\d+)\]$/gm)].map((m) => Number(m[1])));
    const h = /Continue with pages: "([\d-]+)"/.exec(res);
    if (!h) break;
    spec = h[1];
  }
  check('following the hints reads all 30 pages exactly once', seen.join() === Array.from({ length: 30 }, (_, i) => i + 1).join(), seen.join());

  const tight = await read({ path: 'long2.pdf' }, { maxToolOutputChars: 2500, maxToolOutputLines: 60 });
  check('the budget follows the context limits', tight.length <= 2500 && tight.split('\n').length <= 60 && tight.includes('Continue with pages'), `${tight.length} chars, ${tight.split('\n').length} lines`);

  // Few, very long lines: here the character limit is the one that binds, not the line limit.
  put('wide.pdf', longPdf(10, 3, 'y'.repeat(300)));
  const wide = await read({ path: 'wide.pdf' }, { maxToolOutputChars: 3000, maxToolOutputLines: 250 });
  check('the character limit is respected on its own', wide.length <= 3000 && wide.includes('Continue with pages') && wide.split('\n').length < 40, `${wide.length} chars`);

  const scan = await read({ path: 'scan.pdf' });
  check('a scanned PDF is an error result (so the model and UI see a failure)', isToolErrorResult(scan) && scan.includes('scanned document'));
  const rec = put('call.mp4', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
  const recOut = await read({ path: 'call.mp4' });
  check('a recording says to send a transcript, not "binary file"', isToolErrorResult(recOut) && recOut.includes('transcript') && !recOut.includes('binary file'), recOut);
  void rec;

  // Everything else is as before.
  put('notes.txt', 'alpha\nbeta\n');
  check('text files still come back with line numbers', (await read({ path: 'notes.txt' })).includes('   1 | alpha'));
  put('pic.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  check('other binary files are still rejected', (await read({ path: 'pic.png' })).includes('appears to be a binary file'));
  check('a directory is still an error', (await read({ path: '.' })).includes('is a directory'));
  check('a missing file is still an error', (await read({ path: 'nope.pdf' })).startsWith('Error: File not found'));
}

console.log('\n=== @mentions ===');
{
  const a = await resolveFileMentionsAsync('Extract requirements from @report.pdf and compare with @notes.txt', tmp);
  check('a PDF mention attaches its text, page markers included', a.prompt.includes('<document path="report.pdf" type="pdf" pages="3" shown="1-3">') && a.prompt.includes('[p. 2]') && a.prompt.includes('autenticação'), a.errors.join());
  check('...next to an ordinary file in the same prompt', a.prompt.includes('<file path="notes.txt"') && a.errors.length === 0);
  const info = a.attachments.find((x) => x.displayPath === 'report.pdf')!;
  check('the attachment summary reports lines and size', info.mention === '@report.pdf' && info.lines > 5 && info.chars > 100 && info.truncated === false && !info.isDir);
  check('a repeated mention is attached once', ((await resolveFileMentionsAsync('@report.pdf and again @report.pdf', tmp)).prompt.match(/<document /g) ?? []).length === 1);

  const sc = await resolveFileMentionsAsync('read @scan.pdf', tmp);
  check('a scanned PDF is reported, not attached', sc.errors.length === 1 && sc.errors[0].includes('scanned') && !sc.prompt.includes('<document'));
  const rc = await resolveFileMentionsAsync('see @call.mp4', tmp);
  check('a recording asks for a transcript', rc.errors[0].includes('transcript') && !rc.errors[0].includes('binary'));
  const nf = await resolveFileMentionsAsync('see @missing.pdf', tmp);
  check('a missing PDF is "not found" as before', nf.errors[0] === '@missing.pdf: file or directory not found');

  put('big.pdf', longPdf(80, 40, 'x'.repeat(60)));
  const big = await resolveFileMentionsAsync('summarize @big.pdf', tmp);
  const bigInfo = big.attachments[0];
  check('a document over the attachment limit is cut at a page boundary and says how to continue', bigInfo.truncated === true && bigInfo.chars <= 100_500 && /Read them with read_file, pages "\d+-80"/.test(big.prompt), big.errors.join());
  const shown = /shown="([\d-]+)"/.exec(big.prompt)![1];
  const lastShown = Number(shown.split('-').pop());
  check('...and what follows is exactly the next page', big.prompt.includes(`Pages ${lastShown + 1}-80 are not attached`));

  // Paths with spaces (real documents have them) need quotes.
  put('Proposta Técnica 2026.pdf', fs.readFileSync(path.join(tmp, 'report.pdf')));
  put('meeting notes.txt', 'spaced text file');
  const quoted = await resolveFileMentionsAsync('Use @"Proposta Técnica 2026.pdf" and @"meeting notes.txt" please', tmp);
  check('a quoted path with spaces attaches (PDF and text)', quoted.errors.length === 0 && quoted.prompt.includes('<document path="Proposta Técnica 2026.pdf"') && quoted.prompt.includes('<file path="meeting notes.txt"') && quoted.attachments.length === 2, quoted.errors.join());
  check('...with the quotes kept out of the mention name', quoted.attachments[0].mention === '@Proposta Técnica 2026.pdf');
  const unquoted = await resolveFileMentionsAsync('Use @meeting notes.txt please', tmp);
  check('unquoted, the mention still ends at the space (unchanged behavior)', unquoted.errors.length === 1 && unquoted.errors[0] === '@meeting: file or directory not found');
  check('a quoted path that does not exist is reported as written', (await resolveFileMentionsAsync('see @"no such file.pdf"', tmp)).errors[0] === '@no such file.pdf: file or directory not found');
  check('quoted mentions work in the synchronous resolver too', resolveFileMentions('see @"meeting notes.txt"', tmp).prompt.includes('spaced text file'));

  const sync = resolveFileMentions('read @report.pdf', tmp);
  check('the synchronous resolver is unchanged: a PDF is still a binary file there', sync.errors.length === 1 && sync.errors[0].includes('binary file'));
}

console.log('\n=== through a session ===');
{
  const ws = tmp;
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const model = new FakeModel([
    { toolCalls: [{ name: 'run_subagent', args: { task: 'extract the requirements', inputs: ['report.pdf'] } }] },
    { content: 'STATUS: completed\nSUMMARY: done' },
    (req) => ({ content: String(req.messages.filter((m) => m.role === 'tool').pop()?.content) }),
  ]);
  const session = createSession({ workspace: ws, config, client: model.client, skillRoots: [], permissionsDir: path.join(tmp, 'perm') });

  const prepared = await session.prepareInput('what does @report.pdf say about SSO?');
  check('prepareInput attaches a PDF', prepared.prompt.includes('[p. 1]') && prepared.attachments.length === 1);

  await session.run('delegate');
  const childFirst = model.requests[1].messages[1];
  check("a subagent's `inputs` can be a PDF: the child gets its text with page markers", String(childFirst.content).includes('[p. 1]') && String(childFirst.content).includes('Parceiros externos'), String(childFirst.content).slice(0, 200));

  const spaced = new FakeModel([
    { toolCalls: [{ name: 'run_subagent', args: { task: 'read it', inputs: ['Proposta Técnica 2026.pdf', 'meeting notes.txt'] } }] },
    { content: 'STATUS: completed\nSUMMARY: done' },
    (req) => ({ content: String(req.messages.filter((m) => m.role === 'tool').pop()?.content) }),
  ]);
  const s3 = createSession({ workspace: ws, config, client: spaced.client, skillRoots: [], permissionsDir: path.join(tmp, 'perm') });
  await s3.run('delegate files with spaces');
  const spacedFirst = String(spaced.requests[1].messages[1].content);
  check('subagent inputs with spaces in their names reach the child', spacedFirst.includes('[p. 1]') && spacedFirst.includes('spaced text file'), spacedFirst.slice(0, 160));

  const bad = new FakeModel([
    { toolCalls: [{ name: 'run_subagent', args: { task: 'x', inputs: ['scan.pdf'] } }] },
    (req) => ({ content: String(req.messages.filter((m) => m.role === 'tool').pop()?.content) }),
  ]);
  const s2 = createSession({ workspace: ws, config, client: bad.client, skillRoots: [], permissionsDir: path.join(tmp, 'perm') });
  const r2 = await s2.run('delegate a scan');
  check('a scanned PDF as an input stops the subagent before it starts, with the reason', r2.text.includes('could not attach inputs') && r2.text.includes('scanned') && bad.callCount === 2, r2.text.slice(0, 200));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll document checks passed.');
