import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { ContextManager } from '../src/core/context/contextManager.js';
import { resolveFileMentionsAsync } from '../src/core/context/fileMentions.js';
import { SafetyChecker } from '../src/core/safety/safetyChecker.js';
import { readFileTool } from '../src/core/tools/readFile.js';
import { isToolErrorResult } from '../src/core/tools/types.js';
import { documentKind, readDocument } from '../src/core/documents/readDocument.js';
import { descendants, firstKid, kids, ownText, parseXml } from '../src/core/documents/xml.js';
import { FakeModel } from './lib/fakeModel.js';
import { comments, makeDocx, makePptx, w } from './lib/officeFixture.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-office-'));
const put = (name: string, content: Uint8Array | string) => {
  const f = path.join(tmp, name);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, content);
  return f;
};
const ctx = (limits?: ConstructorParameters<typeof ContextManager>[0]) => ({
  workingDirectory: tmp,
  safetyChecker: new SafetyChecker(true),
  contextManager: new ContextManager(limits),
});
const read = (args: object, limits?: ConstructorParameters<typeof ContextManager>[0]) => readFileTool.execute(args as any, ctx(limits));
const text = async (file: string, opts = {}) => {
  const r = await readDocument(file, opts);
  return r.ok ? r.text : `ERROR: ${r.error}`;
};

console.log('\n=== kinds ===');
{
  check('docx family', ['a.docx', 'a.DOCX', 'a.docm', 'a.dotx'].every((f) => documentKind(f) === 'docx'));
  check('pptx family', ['a.pptx', 'a.PPTX', 'a.ppsx', 'a.potx'].every((f) => documentKind(f) === 'pptx'));
  check('old binary formats are recognised so they can be explained', ['a.doc', 'a.ppt', 'a.pps'].every((f) => documentKind(f) === 'legacy'));
  check('pdf and recordings as before, text files are not documents', documentKind('a.pdf') === 'pdf' && documentKind('a.mp4') === 'recording' && documentKind('a.txt') === undefined && documentKind('a.xlsx') === undefined);
}

console.log('\n=== the XML reader ===');
{
  const x = parseXml('<?xml version="1.0"?><!-- note --><a:root xmlns:a="u" id="1"><a:k v="x &gt; y &amp; &quot;z&quot; &#65;&#x42;"/><a:t>one &lt; two</a:t><a:c><![CDATA[<raw & text>]]></a:c><a:q title="a>b"/></a:root>');
  check('names are matched without their namespace prefix', x.name === 'root' && kids(x).map((k) => k.name).join() === 'k,t,c,q');
  check('attributes, entities and numeric references decode', firstKid(x, 'k')!.attrs['v'] === 'x > y & "z" AB');
  check('text, CDATA and a ">" inside a quoted attribute', ownText(firstKid(x, 't')!) === 'one < two' && ownText(firstKid(x, 'c')!) === '<raw & text>' && firstKid(x, 'q')!.attrs['title'] === 'a>b');
  check('descendants walk in document order', descendants(x, 'k').length === 1);
  const throws = (src: string) => {
    try {
      parseXml(src);
      return false;
    } catch {
      return true;
    }
  };
  check('a document that declares entities is refused (no entity-expansion attacks)', throws('<!DOCTYPE x [<!ENTITY a "bbbb">]><x>&a;</x>'));
  check('no element at all is an error', throws('just text'));
  check('unknown entities are left as written, not invented', ownText(parseXml('<a>&nope;</a>')) === '&nope;');
}

console.log('\n=== Word: structure ===');
{
  const docx = put(
    'brd.docx',
    makeDocx({
      body: [
        w.p('Documento de Requisitos', { style: 'Ttulo' }),
        w.p('Texto introdutório com acentuação: coração, ação.'),
        w.h(1, 'Escopo'),
        w.p('O portal atende clientes e parceiros.'),
        w.h(2, 'Fora do escopo'),
        w.p('Integração com o ERP.'),
        w.p('Cabeçalho de estilo próprio', { style: 'MeuCabecalho' }),
        w.p('Item um', { numId: 1 }),
        w.p('Subitem', { numId: 1, ilvl: 1 }),
        w.p('Primeiro passo', { numId: 2 }),
        w.p('Detalhe a', { numId: 2, ilvl: 1 }),
        w.p('Detalhe b', { numId: 2, ilvl: 1 }),
        w.p('Segundo passo', { numId: 2 }),
        w.p('Novo detalhe', { numId: 2, ilvl: 1 }),
        w.p('Outra lista, recomeça', { numId: 3 }),
        w.h(1, 'Requisitos'),
        w.tbl([
          ['ID', 'Descrição', 'Prioridade'],
          ['RF-01', ['Login com SSO', 'via OIDC'], 'Alta'],
          [{ text: 'Mesclada em duas colunas', span: 2 }, 'Baixa'],
          ['RF|03', 'tem | pipe', ''],
        ]),
        w.p('Depois da tabela.'),
        w.p('', { raw: w.r('com ') + w.r('várias ') + w.r('execuções') + '<w:r><w:tab/></w:r>' + w.r('e tab') }),
      ].join(''),
    })
  );
  const r = await readDocument(docx);
  check('reads, as parts', r.ok && r.kind === 'docx' && r.unit === 'part', r.ok ? '' : r.error);
  const t = r.ok ? r.text : '';
  check('a new part starts at each top-level heading, introduced by a marker with its title', t.includes('[part 1: Documento de Requisitos]') && t.includes('[part 2: Escopo]') && t.includes('[part 3: Requisitos]') && r.ok && r.totalPages === 3, t.slice(0, 200));
  check('headings keep their level (Portuguese style ids resolved through the style names)', t.includes('# Documento de Requisitos') && t.includes('# Escopo') && t.includes('## Fora do escopo'));
  check('a style with an outline level counts as a heading', t.includes('## Cabeçalho de estilo próprio'));
  check('accents survive', t.includes('coração, ação') && t.includes('Integração'));
  check('bullets, nested', t.includes('- Item um') && t.includes('  - Subitem'));
  check('numbered lists count, nest and restart', t.includes('1. Primeiro passo\n  1. Detalhe a\n  2. Detalhe b\n2. Segundo passo\n  1. Novo detalhe') && t.includes('1. Outra lista, recomeça'), t);
  check('a table becomes a pipe table with a header row', t.includes('| ID | Descrição | Prioridade |\n| --- | --- | --- |'));
  check('a cell with two paragraphs stays one cell', t.includes('| RF-01 | Login com SSO / via OIDC | Alta |'));
  check('a merged cell keeps the columns aligned', t.includes('| Mesclada em duas colunas |  | Baixa |'));
  check('a pipe inside a cell is escaped', t.includes('| RF\\|03 | tem \\| pipe |'));
  check('runs are joined and a tab survives', t.includes('com várias execuções\te tab'));
  check('text after a table continues', t.indexOf('Depois da tabela.') > t.indexOf('RF\\|03'));
  check('no warnings for a plain document', r.ok && r.warnings.length === 0);

  const part2 = await readDocument(docx, { pages: '2' });
  check('a single part, with its real number', part2.ok && part2.text.startsWith('[part 2: Escopo]') && !part2.text.includes('Requisitos\n') && part2.pagesShown.join() === '2');
}

console.log('\n=== Word: lists whose numbering comes from the style ===');
{
  // Word's built-in "List Bullet" / "List Number" carry their numbering in the style, not on each paragraph.
  const styled = put(
    'styled-lists.docx',
    makeDocx({
      body: [
        w.p('Login corporativo', { style: 'ListBullet' }),
        w.p('Consulta de pedidos', { style: 'ListBullet' }),
        w.p('Primeiro', { style: 'ListNumber' }),
        w.p('Segundo (herda de List Number)', { style: 'ListNumberSub' }),
        w.p('Terceiro', { style: 'ListNumber' }),
        w.p('Sem lista, mesmo com estilo', { style: 'ListBullet', numId: 0 }),
        w.p('Parágrafo comum'),
      ].join(''),
    })
  );
  const t = await text(styled);
  check('a style-based bullet list keeps its markers', t.includes('- Login corporativo\n- Consulta de pedidos'), t);
  check('a style-based numbered list counts, including a style based on another', t.includes('1. Primeiro\n2. Segundo (herda de List Number)\n3. Terceiro'), t);
  check('numbering switched off on the paragraph wins over the style', t.includes('Sem lista, mesmo com estilo') && !t.includes('- Sem lista') && !/\d\. Sem lista/.test(t));
  check('ordinary paragraphs are not lists', t.includes('Parágrafo comum') && !t.includes('- Parágrafo'));
}

console.log('\n=== Word: reviewers, changes, images, odd content ===');
{
  const body = [
    w.h(1, 'Revisão'),
    w.p('', { raw: w.r('Mantido. ') + '<w:del><w:r><w:delText>texto removido</w:delText></w:r></w:del>' + '<w:ins><w:r><w:t>texto inserido</w:t></w:r></w:ins>' }),
    w.p('', { raw: '<w:hyperlink><w:r><w:t>link da proposta</w:t></w:r></w:hyperlink>' }),
    w.p('', { raw: '<mc:AlternateContent><mc:Choice><w:r><w:t>escolha</w:t></w:r></mc:Choice><mc:Fallback><w:r><w:t>reserva duplicada</w:t></w:r></mc:Fallback></mc:AlternateContent>' }),
    '<w:sdt><w:sdtContent>' + w.p('Dentro de um controle de conteúdo') + '</w:sdtContent></w:sdt>',
    w.p('', { raw: '<w:r><w:drawing/></w:r>' }),
    w.p('', { raw: '<w:r><w:drawing/></w:r>' }),
    w.p('   '),
  ].join('');
  const docx = put('review.docx', makeDocx({ body, comments: comments([{ author: 'Newton', text: 'Confirmar SSO com o cliente' }, { text: 'Sem autor' }]) }));
  const r = await readDocument(docx);
  const t = r.ok ? r.text : '';
  check('tracked insertions are read, deletions are not', t.includes('Mantido. texto inserido') && !t.includes('texto removido'));
  check('hyperlink text is kept', t.includes('link da proposta'));
  check('alternate content is read once, not twice', t.includes('escolha') && !t.includes('reserva duplicada'));
  check('content controls are read', t.includes('Dentro de um controle de conteúdo'));
  check("reviewers' comments are kept, with their author, as a part of their own", t.includes('[part 2: Comments]') && t.includes('- Newton: Confirmar SSO com o cliente') && t.includes('- Sem autor'), t);
  check('images are counted in a warning (their content is not available)', r.ok && r.warnings.some((x) => x.includes('2 images')), r.ok ? r.warnings.join() : '');
  check('blank paragraphs vanish', !/\n\n\n/.test(t));
}

console.log('\n=== Word: long documents are split and read in chunks ===');
{
  const filler = 'Este parágrafo descreve um requisito com bastante texto para ocupar espaço. '.repeat(8);
  const body = w.h(1, 'Único capítulo') + Array.from({ length: 60 }, (_, i) => w.p(`Parágrafo ${i + 1}. ${filler}`)).join('');
  const long = put('long.docx', makeDocx({ body }));
  const full = await readDocument(long);
  check('a long chapter is split into several parts at paragraph boundaries', full.ok && full.totalPages > 3 && full.text.includes('Parágrafo 1.') && full.text.includes('Parágrafo 60.'));

  let spec = '1-';
  const got: number[] = [];
  const chunks: string[] = [];
  for (let hops = 0; spec && hops < 40; hops++) {
    const c = await readDocument(long, { pages: spec, maxChars: 9000 });
    if (!c.ok) break;
    got.push(...c.pagesShown);
    chunks.push(c.text);
    spec = c.nextPage ? `${c.nextPage}-` : '';
  }
  check('following nextPage reads every part exactly once', full.ok && got.join() === Array.from({ length: full.totalPages }, (_, i) => i + 1).join());
  check('...and the chunks equal the whole', full.ok && chunks.join('\n\n') === full.text);

  const tool = await read({ path: 'long.docx' });
  check('read_file says what it is and how to go on, in the document\'s own unit', tool.startsWith('--- Document: long.docx (DOCX, ') && / parts\) ---/.test(tool.split('\n')[0]) && /\[Showing parts 1-\d+ of \d+\. Continue with pages: "\d+-\d+"\.\]/.test(tool), tool.split('\n').slice(-1)[0]);
  check('the tool result respects the default limits', tool.length <= 16000 && tool.split('\n').length <= 250);
}

console.log('\n=== PowerPoint ===');
{
  const deck = put(
    'deck.pptx',
    makePptx({
      slides: [
        { title: 'Visão geral', body: ['Portal do cliente', '> Pedidos', '> Chamados', '>> Abertura e acompanhamento'], notes: 'Falar sobre o escopo.\nCitar o ADR-0003.', footer: 'Confidencial' },
        { title: 'Tabela de prazos', table: [['Fase', 'Prazo'], ['MVP', 'Q1'], ['Fase 2', 'Q3']] },
        { notes: 'Slide só com notas: decisão sobre SSO adiada.' },
        { title: 'Arquitetura', images: [{ descr: 'Diagrama do monólito modular' }, {}], chart: true, grouped: 'Texto dentro de um grupo' },
        { images: [{}] },
        { title: 'Slide oculto', body: ['não apresentar'], hidden: true },
        {},
      ],
      order: [2, 1, 3, 4, 5, 6, 7], // presentation order differs from the file numbers
    })
  );
  const r = await readDocument(deck);
  const t = r.ok ? r.text : '';
  check('reads, as slides', r.ok && r.kind === 'pptx' && r.unit === 'slide' && r.totalPages === 7, r.ok ? '' : r.error);
  check('slides follow the presentation order, not the file numbers', t.indexOf('Tabela de prazos') < t.indexOf('Visão geral') && t.startsWith('[slide 1]\n# Tabela de prazos'), t.slice(0, 80));
  check('titles are headings, text keeps its levels', t.includes('# Visão geral\nPortal do cliente\n- Pedidos\n- Chamados\n  - Abertura e acompanhamento'), t);
  check('speaker notes are kept, after the slide text', t.includes('Notes:\nFalar sobre o escopo.\nCitar o ADR-0003.') && t.indexOf('Citar o ADR-0003') > t.indexOf('Abertura e acompanhamento'));
  check('footers and slide numbers are not text', !t.includes('Confidencial') && !t.includes('‹#›'));
  const slide2 = t.split('[slide 2]')[1].split('[slide 3]')[0];
  check("the notes hold only the notes (not the notes page's slide image or slide number)", slide2.trimEnd().endsWith('Notes:\nFalar sobre o escopo.\nCitar o ADR-0003.'), JSON.stringify(slide2.slice(-60)));
  check('a table becomes a pipe table', t.includes('| Fase | Prazo |\n| --- | --- |\n| MVP | Q1 |'));
  check('a slide that only has notes is not lost', t.includes('[slide 3]\nNotes:\nSlide só com notas: decisão sobre SSO adiada.'));
  check('image descriptions are kept, charts noted, groups read', t.includes('[image: Diagrama do monólito modular]') && t.includes('[chart]') && t.includes('Texto dentro de um grupo'));
  check('a hidden slide is marked', t.includes('[slide 6, hidden]') && r.ok && r.warnings.some((x) => x.includes('hidden') && x.includes('6')));
  check('an image-only slide is flagged as missing content', r.ok && r.warnings.some((x) => x.includes('only images') && x.includes('5')), r.ok ? r.warnings.join('|') : '');
  check('an empty slide is flagged', r.ok && r.warnings.some((x) => x.includes('no text and no notes') && x.includes('7')) && t.includes('[slide 7]\n(no text)'));

  const s3 = await readDocument(deck, { pages: '3' });
  check('a selection keeps the real slide number', s3.ok && s3.pagesShown.join() === '3' && s3.text.startsWith('[slide 3]'));

  const tool = await read({ path: 'deck.pptx', pages: '1-2' });
  check('read_file: header, slides only, and what was shown', tool.startsWith('--- Document: deck.pptx (PPTX, 7 slides) ---\n[slide 1]') && tool.includes('[Showing slides 1-2 of 7.]') && !tool.includes('[slide 3]'), tool.split('\n').slice(-1)[0]);

  const small = await read({ path: 'deck.pptx' }, { maxToolOutputChars: 1100, maxToolOutputLines: 40 });
  check('a big deck is returned slide by slide, with the way on', /Continue with pages: "\d+-\d+"/.test(small) && small.includes('[Showing slides 1-') && small.length <= 1100 && small.split('\n').length <= 40, `${small.length} chars: ${small.split('\n').slice(-1)[0]}`);

  const short = await readDocument(put('short.pptx', makePptx({ slides: [{ title: 'Q&A' }, { title: 'Fim' }] })));
  check('very short slide text ("Q&A") is content, not an empty slide', short.ok && short.text.includes('# Q&A') && short.warnings.length === 0, short.ok ? short.warnings.join() : short.error);

  const onlyImages = put('pics.pptx', makePptx({ slides: [{ images: [{}] }, { images: [{}, {}] }] }));
  const oi = await readDocument(onlyImages);
  check('a deck of pictures only is refused, with the reason', !oi.ok && oi.error.includes('only images') && oi.error.includes('2 slides'), oi.ok ? 'ok' : oi.error);
}

console.log('\n=== errors and limits ===');
{
  // Stand-ins for old binary Office files (only the extension matters).
  put('old.doc', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  put('old.ppt', Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
  const notZip = await readDocument(put('fake.docx', 'this is plainly not a zip file'));
  check('a file that is not an Office package is a clear error', !notZip.ok && notZip.error.includes('not a valid Office file') && notZip.error.includes('password protected'), notZip.ok ? 'ok' : notZip.error);
  const noDoc = await readDocument(put('hollow.docx', zipSync({ 'readme.txt': strToU8('hi') })));
  check('a zip without the Word body says so', !noDoc.ok && noDoc.error.includes('word/document.xml'));
  const noDeck = await readDocument(put('hollow.pptx', zipSync({ 'readme.txt': strToU8('hi') })));
  check('...and without a presentation', !noDeck.ok && noDeck.error.includes('ppt/presentation.xml'));
  const blank = await readDocument(put('blank.docx', makeDocx({ body: w.p('   ') })));
  check('a document with no text', !blank.ok && blank.error.includes('no text') || (!blank.ok && blank.error.includes('no content')), blank.ok ? 'ok' : blank.error);
  const bomb = await readDocument(put('bomb.docx', zipSync({ 'word/document.xml': new Uint8Array(41 * 1024 * 1024) }, { level: 1 })));
  check('an entry that would inflate past 40 MB is refused before it is inflated', !bomb.ok && bomb.error.includes('too large'), bomb.ok ? 'ok' : bomb.error);
  const evil = await readDocument(put('entities.docx', makeDocx({ body: '<!DOCTYPE x [<!ENTITY a "boom">]><w:p>&a;</w:p>' })));
  check('a body that declares entities is refused', !evil.ok);
  const legacyDoc = await readDocument(path.join(tmp, 'old.doc'));
  check('.doc: save it as .docx', !legacyDoc.ok && legacyDoc.error.includes('old binary Office format') && legacyDoc.error.includes('.docx'));
  const legacyPpt = await readDocument(path.join(tmp, 'old.ppt'));
  check('.ppt: save it as .pptx', !legacyPpt.ok && legacyPpt.error.includes('.pptx'));
  const bad = await readDocument(path.join(tmp, 'brd.docx'), { pages: '99' });
  check('a part past the end says how many there are', !bad.ok && bad.error.includes('3 parts'), bad.ok ? 'ok' : bad.error);
  const badDeck = await readDocument(path.join(tmp, 'deck.pptx'), { pages: '40' });
  check('a slide past the end, too', !badDeck.ok && badDeck.error.includes('7 slides'));
  check('read_file reports them as errors', isToolErrorResult(await read({ path: 'fake.docx' })) && isToolErrorResult(await read({ path: 'old.doc' })) && (await read({ path: 'old.doc' })).includes('save it as .docx'), await read({ path: 'old.doc' }));
}

console.log('\n=== @mentions and subagents ===');
{
  const m = await resolveFileMentionsAsync('Extract from @brd.docx and @deck.pptx', tmp);
  check('a Word document attaches, counted in parts', m.prompt.includes('<document path="brd.docx" type="docx" parts="3" shown="1-3">') && m.prompt.includes('[part 2: Escopo]'), m.errors.join());
  check('a deck attaches, counted in slides, notes included', m.prompt.includes('<document path="deck.pptx" type="pptx" slides="7" shown="1-7">') && m.prompt.includes('Falar sobre o escopo.'));
  check('both are in the attachment summary', m.attachments.length === 2 && m.errors.length === 0);
  const legacy = await resolveFileMentionsAsync('see @old.doc', tmp);
  check('a legacy file in a mention gives the same advice', legacy.errors.length === 1 && legacy.errors[0].includes('Save it as .docx') || legacy.errors[0]?.includes('save it as .docx') === true, legacy.errors.join());
  const fake = await resolveFileMentionsAsync('see @fake.docx', tmp);
  check('a broken one is reported, not attached', fake.errors.length === 1 && fake.errors[0].includes('not a valid Office file') && !fake.prompt.includes('<document'));

  put('Relatório Final 2026.docx', fs.readFileSync(path.join(tmp, 'brd.docx')));
  const spaced = await resolveFileMentionsAsync('see @"Relatório Final 2026.docx"', tmp);
  check('quoted names with spaces work for Office files too', spaced.errors.length === 0 && spaced.prompt.includes('<document path="Relatório Final 2026.docx"'));

  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const model = new FakeModel([
    { toolCalls: [{ name: 'run_subagent', args: { task: 'extract requirements', inputs: ['deck.pptx', 'Relatório Final 2026.docx'] } }] },
    { content: 'STATUS: completed\nSUMMARY: done' },
    (req) => ({ content: String(req.messages.filter((x) => x.role === 'tool').pop()?.content) }),
  ]);
  const session = createSession({ workspace: tmp, config, client: model.client, skillRoots: [], permissionsDir: path.join(tmp, 'perm') });
  await session.run('delegate');
  const first = String(model.requests[1].messages[1].content);
  check("a subagent's inputs can be a deck and a Word file", first.includes('[slide 1]') && first.includes('[part 2: Escopo]') && first.includes('Citar o ADR-0003'), first.slice(0, 120));
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll Office document checks passed.');
