/**
 * Every word the user reads comes from the catalog (renderer/src/i18n/pt-BR.ts), not from a component (A18): one place to review
 * the wording, and the pt-BR strings of the design in one list. The renderer's sources are parsed (Babel's parser: TypeScript 7 no longer ships a JavaScript API),
 * and any text between tags, and any title, label, placeholder or alt written inline, is reported.
 * Run from desktop/: `npm run test:strings`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const src = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src');
const files: string[] = [];
const walk = (dir: string) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx$/.test(e.name)) files.push(p);
  }
};
walk(src);

/** Text that is not words: symbols, arrows, numbers, a key name in a shortcut. */
const isWords = (text: string): boolean => {
  const t = text.replace(/\s+/g, ' ').trim();
  if (!/\p{L}{2,}/u.test(t)) return false;
  return true;
};
/** Technical text that is the same in any language (a product, a key name): shown as written, never translated. */
const TECHNICAL_WORDS = new Set(['Ctrl N', 'OK', 'alia', 'Electron']);
const TECHNICAL = { has: (t: string) => TECHNICAL_WORDS.has(t.replace(/^[\s·]+|[\s·]+$/g, '')) };
const ATTRIBUTES = new Set(['aria-label', 'title', 'placeholder', 'alt', 'aria-description', 'aria-roledescription']);

const offenders: string[] = [];
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = parse(text, { sourceType: 'module', plugins: ['jsx', 'typescript'] });
  const at = (node: any) => `${path.relative(src, file)}:${node.loc?.start.line ?? '?'}`;
  const visit = (node: any): void => {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'JSXText') {
      const t = String(node.value).replace(/\s+/g, ' ').trim();
      if (t && isWords(t) && !TECHNICAL.has(t)) offenders.push(`${at(node)} text "${t}"`);
    }
    if (node.type === 'JSXAttribute' && node.value?.type === 'StringLiteral' && ATTRIBUTES.has(node.name?.name) && isWords(node.value.value) && !TECHNICAL.has(node.value.value)) {
      offenders.push(`${at(node)} ${node.name.name}="${node.value.value}"`);
    }
    if (node.type === 'JSXExpressionContainer' && node.expression?.type === 'StringLiteral' && isWords(node.expression.value) && !TECHNICAL.has(node.expression.value.trim())) {
      offenders.push(`${at(node)} {"${node.expression.value}"}`);
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (Array.isArray(child)) child.forEach(visit);
      else if (child && typeof child === 'object') visit(child);
    }
  };
  visit(ast.program);
}

check(`${files.length} components were read`, files.length > 20);
check('no component carries words of its own', offenders.length === 0, '\n    ' + offenders.join('\n    '));

// The catalog itself: no empty strings and nothing left as a placeholder.
const catalog = fs.readFileSync(path.join(src, 'i18n', 'pt-BR.ts'), 'utf8');
check('the catalog has no empty or placeholder strings (the one category that is deliberately blank aside)', !/^\s*[\w'"-]+:\s*'',?\s*$/m.test(catalog) && !/TODO|FIXME|lorem ipsum/.test(catalog));

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll string checks passed.');
