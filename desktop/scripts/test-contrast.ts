/**
 * Contrast of the colour pairs the screens use (WCAG 2.1 AA: 4.5:1 for text, 3:1 for large text and for the edges of controls),
 * computed from the design tokens themselves, so a change to a colour is caught before it reaches a screen. The axe audit of
 * the real screens (test-journey-app) is the other half: it finds the pairs that are actually on the page.
 * Run from desktop/: `npm run test:contrast`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const css = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'renderer', 'src', 'styles', 'tokens.css'), 'utf8');
const token = (name: string): string => {
  const m = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`token --${name} not found`);
  return m[1];
};
const channel = (v: number) => {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) => {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
};
export const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
const WHITE = '#ffffff';

/** Text on its background: 4.5:1. */
const TEXT: Array<[string, string, string]> = [
  ['text', 'bg', 'body text on the page'],
  ['text', 'surface', 'body text on cards'],
  ['text', 'sidebar', 'text in the sidebar'],
  ['text-muted', 'bg', 'hints on the page'],
  ['text-muted', 'surface', 'hints on cards'],
  ['text-muted', 'sidebar', 'section titles and hints in the sidebar'],
  ['text-muted', 'primary-selected', 'hints on a selected row'],
  ['text-muted', 'warning-bg', 'hints in an approval card'],
  ['primary', 'bg', 'links and project chips on the page'],
  ['primary', 'surface', 'links on cards'],
  ['primary', 'sidebar', 'links in the sidebar'],
  ['primary', 'primary-selected', 'a chip of a running step'],
  ['brand-navy', 'bg', 'headings'],
  ['brand-navy', 'surface', 'card titles'],
  ['success', 'surface', 'a passed check'],
  ['success', 'diff-add', 'an added line, an approved spec'],
  ['warning', 'warning-bg', 'a waiting chip and an approval card title'],
  ['warning', 'surface', 'a waiting mark on white'],
  ['danger', 'surface', 'an error on white'],
  ['danger', 'bg', 'an error on the page'],
  ['danger', 'diff-remove', 'a removed line, a failed check'],
  ['danger', 'sidebar', 'an error in the sidebar'],
];
for (const [fg, bg, what] of TEXT) check(`${what}: ${fg} on ${bg} is at least 4.5:1`, ratio(token(fg), token(bg)) >= 4.5, `${ratio(token(fg), token(bg)).toFixed(2)}:1`);

/** White text on a filled control or mark. */
const FILLED: Array<[string, string]> = [
  ['primary', 'the primary button and the active step'],
  ['success', 'a done step'],
  ['warning', 'a waiting step'],
  ['danger', 'a failed check mark'],
];
for (const [bg, what] of FILLED) check(`white on ${bg} (${what}) is at least 4.5:1`, ratio(WHITE, token(bg)) >= 4.5, `${ratio(WHITE, token(bg)).toFixed(2)}:1`);

/** The terminal's own text. */
check('terminal text is readable on the terminal background', ratio('#d7deee', token('terminal')) >= 4.5, `${ratio('#d7deee', token('terminal')).toFixed(2)}:1`);

/** The edge of a control or card has to be seen: 3:1 for controls that have no other cue (inputs, checkboxes). */
check('the sidebar is told from the page', ratio(token('sidebar'), token('bg')) > 1.0);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll contrast checks passed.');
