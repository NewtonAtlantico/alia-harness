/**
 * Unit tests for the composer's text logic (A7): finding the @mention and /command at the caret, inserting the chosen
 * entry, quoting, attachments, input history, and the timeline's local rows. No browser.
 * Run from desktop/: `npm run test:composer-logic`.
 */
import { InputHistory, activeMention, activeSlash, applyCommand, applyMention, filterCommands, parseSlash, quoteIfNeeded, withAttachments } from '../src/renderer/src/lib/composer';
import { applyPush, emptyTimeline } from '../src/renderer/src/lib/timeline';
import type { CommandInfo } from '../src/shared/ipc';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}
const mention = (text: string, caret = text.length) => activeMention(text, caret);

console.log('\n=== finding the @mention at the caret ===');
{
  check('a bare @ at the start', JSON.stringify(mention('@')) === JSON.stringify({ start: 0, end: 1, query: '', quoted: false }));
  check('what follows it is the query', mention('leia @src/ap')?.query === 'src/ap' && mention('leia @src/ap')?.start === 5);
  check('an @ after a space or a new line starts one', mention('a\n@x')?.query === 'x' && mention('a   @x')?.query === 'x');
  check('an email is not a mention', mention('ana@example') === undefined && mention('escreva para ana@exa') === undefined);
  check('a space ends an unquoted mention', mention('@src/app.ts ') === undefined && mention('@a b') === undefined);
  check('a quote opens one that may hold spaces', JSON.stringify(mention('veja @"Proposta Téc')) === JSON.stringify({ start: 5, end: 19, query: 'Proposta Téc', quoted: true }));
  check('...until the quote is closed', mention('veja @"Proposta.pdf" e') === undefined && mention('@"a b"') === undefined);
  check('the caret decides: in the middle of the text only what is before it counts', mention('leia @sr e mais', 8)?.query === 'sr' && mention('leia @src', 3) === undefined);
  check('a new line cuts a quoted mention short', mention('@"abc\ndef') === undefined);
  check('no @, no mention', mention('') === undefined && mention('texto simples') === undefined);
  check('the second of two mentions is the one at the caret', mention('@a.ts e @b')?.query === 'b' && mention('@a.ts e @b')?.start === 8);
}

console.log('\n=== putting the chosen entry into the text ===');
{
  const m = mention('leia @src/ap')!;
  const file = applyMention('leia @src/ap', m, { path: 'src/app.ts', isDir: false }, 'complete');
  check('a file: the whole path and a space, caret after it', file.text === 'leia @src/app.ts ' && file.caret === file.text.length);
  const dirWhole = applyMention('leia @sr', mention('leia @sr')!, { path: 'src', isDir: true }, 'complete');
  check('a folder with Enter: "pasta inteira", the slash kept, followed by a space', dirWhole.text === 'leia @src/ ' && dirWhole.caret === 11);
  const dirDrill = applyMention('leia @sr', mention('leia @sr')!, { path: 'src', isDir: true }, 'drill');
  check('a folder with Tab: left open to look inside (no space)', dirDrill.text === 'leia @src/' && activeMention(dirDrill.text, dirDrill.caret)?.query === 'src/');
  check('Tab on a file is the same as Enter', applyMention('@a', mention('@a')!, { path: 'a.ts', isDir: false }, 'drill').text === '@a.ts ');
  const spaced = applyMention('veja @Prop', mention('veja @Prop')!, { path: 'docs/Proposta Técnica 2026.pdf', isDir: false }, 'complete');
  check('a path with spaces is quoted', spaced.text === 'veja @"docs/Proposta Técnica 2026.pdf" ');
  const spacedDir = applyMention('@do', mention('@do')!, { path: 'meus docs', isDir: true }, 'drill');
  check('a folder with spaces, left open, keeps its quote open so the menu continues', spacedDir.text === '@"meus docs/' && activeMention(spacedDir.text, spacedDir.caret)?.quoted === true && activeMention(spacedDir.text, spacedDir.caret)?.query === 'meus docs/');
  const middle = applyMention('leia @sr e mais', mention('leia @sr e mais', 8)!, { path: 'src/x.ts', isDir: false }, 'complete');
  check('in the middle of a text, what follows the caret is kept', middle.text === 'leia @src/x.ts  e mais' && middle.caret === 15);
  check('a folder path that already ends in a slash gets one slash', applyMention('@a', mention('@a')!, { path: 'a/', isDir: true }, 'complete').text === '@a/ ');
  check('quoting only when there is whitespace', quoteIfNeeded('a/b.ts') === 'a/b.ts' && quoteIfNeeded('a b.ts') === '"a b.ts"');
}

console.log('\n=== slash commands ===');
{
  const commands: CommandInfo[] = [
    { name: 'help', description: 'Ajuda', acceptsArgs: false, kind: 'builtin' },
    { name: 'model', description: 'Trocar de modelo', acceptsArgs: true, kind: 'builtin' },
    { name: 'models', description: 'Listar modelos', acceptsArgs: false, kind: 'builtin' },
    { name: 'clear', description: 'Limpar', acceptsArgs: false, kind: 'builtin' },
    { name: 'compact', description: 'Compactar', acceptsArgs: false, kind: 'builtin' },
    { name: 'config', description: 'Configurações', acceptsArgs: false, kind: 'host' },
    { name: 'requirements-to-tasks-pipeline', description: 'Pipeline', acceptsArgs: true, kind: 'skill' },
  ];
  check('a bare / shows all of them, in the given order', filterCommands(commands, '').length === 7 && filterCommands(commands, '')[0].name === 'help');
  check('typing narrows by the start of the name', filterCommands(commands, 'mo').map((c) => c.name).join() === 'model,models' && filterCommands(commands, 'C').map((c) => c.name).join() === 'clear,config,compact');
  check('the closest name comes first, even when the registry lists the longer one earlier', filterCommands([{ ...commands[2], name: 'models' }, { ...commands[1], name: 'model' }], 'mo')[0].name === 'model');
  check('with no name starting with it, those that contain it', filterCommands(commands, 'tasks').map((c) => c.name).join() === 'requirements-to-tasks-pipeline');
  check('nothing matches nothing', filterCommands(commands, 'zzz').length === 0);
  check('it is a command only in the first word, and only while the caret is in it', JSON.stringify(activeSlash('/mo')) === JSON.stringify({ query: 'mo', end: 3 }) && activeSlash('/model gpt', 9) === undefined && activeSlash('/model gpt', 3)?.query === 'model' && activeSlash('oi /model') === undefined && activeSlash('') === undefined);
  const s = activeSlash('/mo')!;
  check('choosing one replaces the word, adding a space when it takes arguments', applyCommand('/mo', s, commands[1]).text === '/model ' && applyCommand('/he', activeSlash('/he')!, commands[0]).text === '/help');
  check('...and keeps what was already typed after it', applyCommand('/mo gpt-oss', activeSlash('/mo gpt-oss', 2)!, commands[1]).text === '/model gpt-oss' && applyCommand('/he', activeSlash('/he')!, commands[0]).caret === 5);
  check('parsing a typed command', JSON.stringify(parseSlash('/model gpt-oss:20b')) === JSON.stringify({ name: 'model', arg: 'gpt-oss:20b' }) && JSON.stringify(parseSlash('  /CLEAR  ')) === JSON.stringify({ name: 'clear', arg: '' }));
  check('a path or ordinary text is not a command', parseSlash('/etc/hosts o que é isso?') === undefined && parseSlash('olá') === undefined && parseSlash('/') === undefined);
}

console.log('\n=== attached files ===');
{
  check('nothing attached, nothing added', withAttachments('oi', []) === 'oi');
  check('each file becomes a mention on its own line, quoted when needed', withAttachments('resuma', ['C:\\Docs\\BRD v2.pdf', 'C:\\Docs\\notas.txt']) === 'resuma\n@"C:\\Docs\\BRD v2.pdf" @C:\\Docs\\notas.txt');
  check('with no text, just the mentions', withAttachments('  ', ['/a/b.pdf']) === '@/a/b.pdf');
}

console.log('\n=== input history ===');
{
  const h = new InputHistory();
  check('empty: nothing to go back to', h.prev('') === undefined && h.next() === undefined && !h.browsing);
  h.push('um');
  h.push('dois');
  h.push('dois');
  h.push('   ');
  h.push('três');
  check('repeats in a row and blanks are not kept', h.entries.join() === 'um,dois,três');
  check('Up goes back through what was sent, newest first, remembering the draft', h.prev('rascunho') === 'três' && h.prev('xx') === 'dois' && h.prev('xx') === 'um' && h.browsing);
  check('...and stops at the oldest', h.prev('xx') === undefined);
  check('Down comes back, ending at the draft', h.next() === 'dois' && h.next() === 'três' && h.next() === 'rascunho' && !h.browsing);
  check('Down when not browsing does nothing', h.next() === undefined);
  h.prev('novo');
  h.reset();
  check('typing stops the browsing', !h.browsing && h.prev('a') === 'três');
  h.push('quatro');
  check('sending starts over from the newest', h.prev('') === 'quatro' && !new InputHistory(['a', 'b']).browsing);
  const small = new InputHistory([], 3);
  for (const x of ['1', '2', '3', '4', '5']) small.push(x);
  check('the list is capped, dropping the oldest', small.entries.join() === '3,4,5' && new InputHistory(['a', 'b', 'c', 'd'], 2).entries.join() === 'c,d');
}

console.log('\n=== what a local command leaves in the timeline ===');
{
  let s = applyPush(emptyTimeline, { kind: 'local', command: 'tokens', text: 'Contexto: 12%' });
  check('app-only commands print a row of their own, with the command named', s.rows.length === 1 && s.rows[0].kind === 'local' && (s.rows[0] as any).command === 'tokens' && (s.rows[0] as any).text === 'Contexto: 12%');
  s = applyPush(s, { kind: 'user_message', sessionId: 's', text: 'olá' });
  const cleared = applyPush(s, { kind: 'cleared' });
  check('/clear empties the timeline', cleared.rows.length === 0 && !cleared.running && !cleared.modelBusy);
  check('...and ids keep counting, so a later row never repeats an earlier id', cleared.seq === s.seq && applyPush(cleared, { kind: 'local', command: 'help', text: 'x' }).rows[0].id !== s.rows[0].id);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll composer logic checks passed.');
