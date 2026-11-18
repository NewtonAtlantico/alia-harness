import { createRequire } from 'node:module';
import pc from 'picocolors';
import { brandGradient, brandLight, muted, truncate } from './theme.js';

/**
 * Pixel-font rendering of the lowercase "alia" wordmark.
 * Each "#" is drawn as a 2-char-wide block so pixels look square.
 */
const GLYPHS: Record<string, string[]> = {
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  l: ['#', '#', '#', '#', '#', '#', '#'],
  i: ['#', '.', '#', '#', '#', '#', '#'],
};

const WORD = ['a', 'l', 'i', 'a'];
const LOGO_HEIGHT = 7;

/** Returns the wordmark as coloured lines (vertical brand gradient). */
export function renderWordmark(): string[] {
  const lines: string[] = [];
  for (let row = 0; row < LOGO_HEIGHT; row++) {
    const raw = WORD.map((ch) => GLYPHS[ch][row])
      .join('.')
      .split('')
      .map((c) => (c === '#' ? '██' : '  '))
      .join('');
    lines.push(brandGradient(row / (LOGO_HEIGHT - 1))(raw));
  }
  return lines;
}

export const WORDMARK_WIDTH = (() => {
  const row = WORD.map((ch) => GLYPHS[ch][0]).join('.');
  return row.length * 2;
})();

function readVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    return require('../../package.json').version as string;
  } catch {
    return undefined;
  }
}

export interface BannerInfo {
  model: string;
  vendor: string;
  endpoint: string;
  cwd: string;
}

/** Builds the full startup banner (logo + session details) as lines. */
export function renderBanner(info: BannerInfo, columns = process.stdout.columns || 80): string[] {
  const logo = renderWordmark();
  const version = readVersion();

  const label = (s: string) => muted(s.padEnd(9));
  const sideBySide = columns >= WORDMARK_WIDTH + 4 + 46;
  const gap = '    ';
  const rightWidth = sideBySide ? columns - WORDMARK_WIDTH - gap.length - 2 : columns - 4;
  const valueWidth = Math.max(10, rightWidth - 9);

  const title =
    pc.bold(brandLight('Harness')) +
    muted(' · AI Agent CLI') +
    (version ? muted(`  v${version}`) : '');
  const subtitle = muted('Laboratório de inteligência artificial');
  const rule = muted('─'.repeat(Math.min(rightWidth, 44)));
  const details = [
    `${label('Model')}${pc.bold(pc.white(truncate(info.model, valueWidth - info.vendor.length - 3)))} ${muted(`(${info.vendor})`)}`,
    `${label('Endpoint')}${muted(truncate(info.endpoint, valueWidth))}`,
    `${label('Dir')}${muted(truncate(info.cwd, valueWidth))}`,
  ];

  const out: string[] = [''];

  if (sideBySide) {
    // Right column aligned to the 7 logo rows.
    const right = ['', title, subtitle, rule, ...details];
    for (let i = 0; i < LOGO_HEIGHT; i++) {
      out.push('  ' + logo[i] + gap + (right[i] ?? ''));
    }
  } else {
    for (const line of logo) out.push('  ' + line);
    out.push('');
    out.push('  ' + title);
    out.push('  ' + subtitle);
    out.push('  ' + rule);
    for (const d of details) out.push('  ' + d);
  }

  out.push('');
  out.push(
    '  ' +
      muted('Dica: ') +
      pc.white('@') +
      muted(' anexa arquivos · ') +
      pc.white('/') +
      muted(' abre os comandos · ') +
      pc.white('/help') +
      muted(' para ajuda')
  );
  out.push('');
  return out;
}
