import { unzipSync, strFromU8 } from 'fflate';
import { XmlElement, descendants, firstKid, kids, ownText, parseXml } from './xml.js';

/**
 * Word documents (.docx) as readable text: headings as `#`, lists as `-` / `1.`, tables as
 * pipe tables, plus the reviewers' comments. Word has no stable page numbers, so the text is
 * split into "parts" (at each top-level heading, and at about 6,000 characters otherwise), which
 * can be read one at a time.
 *
 * Not extracted: headers and footers, footnotes, images (their number is reported).
 */

export interface DocxPart {
  /** The first heading in the part, if any. */
  title?: string;
  text: string;
}

export interface DocxContent {
  parts: DocxPart[];
  warnings: string[];
}

/** A piece of the document body: a paragraph, a heading, a list item, or a table. */
interface Block {
  text: string;
  heading?: number;
  list?: boolean;
}

/** A part grows to about this many characters before the next paragraph starts a new one. */
const PART_TARGET_CHARS = 6000;
const MAX_ENTRY_BYTES = 40 * 1024 * 1024;

/** Entries needed from the package. Everything else (media, themes, fonts) is never inflated. */
const WANTED = new Set(['word/document.xml', 'word/styles.xml', 'word/numbering.xml', 'word/comments.xml']);

interface StyleInfo {
  name: string;
  outline?: number;
  /** List numbering the style carries itself (Word's "List Bullet", "List Number"). */
  numId?: string;
  ilvl?: number;
  basedOn?: string;
}

function loadStyles(xml: string | undefined): Map<string, StyleInfo> {
  const styles = new Map<string, StyleInfo>();
  if (!xml) return styles;
  for (const style of descendants(parseXml(xml), 'style')) {
    const id = style.attrs['styleId'];
    if (!id) continue;
    const pPr = firstKid(style, 'pPr') ?? style;
    const outline = firstKid(pPr, 'outlineLvl')?.attrs['val'];
    const numPr = firstKid(pPr, 'numPr');
    styles.set(id, {
      name: (firstKid(style, 'name')?.attrs['val'] ?? '').toLowerCase(),
      outline: outline !== undefined ? Number(outline) : undefined,
      numId: numPr && firstKid(numPr, 'numId')?.attrs['val'],
      ilvl: numPr && firstKid(numPr, 'ilvl') ? Number(firstKid(numPr, 'ilvl')!.attrs['val']) : undefined,
      basedOn: firstKid(style, 'basedOn')?.attrs['val'],
    });
  }
  return styles;
}

/** numId -> level -> is it a bullet list? */
function loadNumbering(xml: string | undefined): Map<string, Map<number, boolean>> {
  const result = new Map<string, Map<number, boolean>>();
  if (!xml) return result;
  const root = parseXml(xml);
  const abstracts = new Map<string, Map<number, boolean>>();
  for (const abs of kids(root, 'abstractNum')) {
    const levels = new Map<number, boolean>();
    for (const lvl of kids(abs, 'lvl')) {
      levels.set(Number(lvl.attrs['ilvl'] ?? 0), (firstKid(lvl, 'numFmt')?.attrs['val'] ?? '') === 'bullet');
    }
    abstracts.set(abs.attrs['abstractNumId'], levels);
  }
  for (const num of kids(root, 'num')) {
    const levels = abstracts.get(firstKid(num, 'abstractNumId')?.attrs['val'] ?? '');
    if (levels) result.set(num.attrs['numId'], levels);
  }
  return result;
}

/** The text of a run-level subtree: text, tabs and breaks. Deleted text (`delText`) is not `t`, so it is skipped. */
function inlineText(el: XmlElement): string {
  let out = '';
  for (const c of el.children) {
    if (typeof c === 'string') continue;
    switch (c.name) {
      case 't':
        out += ownText(c);
        break;
      case 'tab':
        out += '\t';
        break;
      case 'br':
      case 'cr':
        out += c.attrs['type'] === 'page' ? '' : '\n';
        break;
      case 'noBreakHyphen':
        out += '-';
        break;
      case 'Fallback':
        break; // mc:AlternateContent carries the same content twice
      case 'del':
      case 'instrText':
      case 'delText':
        break;
      default:
        out += inlineText(c);
    }
  }
  return out;
}

class Converter {
  private counters = new Map<string, number[]>();
  images = 0;

  constructor(
    private styles: Map<string, StyleInfo>,
    private numbering: Map<string, Map<number, boolean>>
  ) {}

  headingLevel(p: XmlElement): number | undefined {
    const pPr = firstKid(p, 'pPr');
    const styleId = pPr && firstKid(pPr, 'pStyle')?.attrs['val'];
    const style = styleId ? this.styles.get(styleId) : undefined;
    const direct = pPr && firstKid(pPr, 'outlineLvl')?.attrs['val'];
    if (direct !== undefined && Number(direct) < 9) return Number(direct) + 1;
    if (style?.name === 'title') return 1;
    const m = /^heading (\d)$/.exec(style?.name ?? '');
    if (m) return Number(m[1]);
    if (style?.outline !== undefined && style.outline < 9) return style.outline + 1;
    return undefined;
  }

  /** The list numbering a style gives its paragraphs, looking through the styles it is based on. */
  private styleNumbering(styleId: string | undefined): { numId: string; ilvl: number } | undefined {
    for (let depth = 0; styleId && depth < 8; depth++) {
      const style = this.styles.get(styleId);
      if (!style) return undefined;
      if (style.numId !== undefined) return { numId: style.numId, ilvl: style.ilvl ?? 0 };
      styleId = style.basedOn;
    }
    return undefined;
  }

  private listPrefix(p: XmlElement): string | undefined {
    const pPr = firstKid(p, 'pPr');
    const numPr = pPr && firstKid(pPr, 'numPr');
    let numId: string | undefined;
    let level = 0;
    if (numPr) {
      // Numbering set on the paragraph itself (numId 0 switches it off).
      numId = firstKid(numPr, 'numId')?.attrs['val'];
      level = Number(firstKid(numPr, 'ilvl')?.attrs['val'] ?? 0);
    } else {
      const fromStyle = this.styleNumbering(pPr && firstKid(pPr, 'pStyle')?.attrs['val']);
      if (fromStyle) {
        numId = fromStyle.numId;
        level = fromStyle.ilvl;
      }
    }
    if (numId === undefined || numId === '0') return undefined;
    const indent = '  '.repeat(level);
    if (this.numbering.get(numId)?.get(level) !== false) return `${indent}- `;
    // Numbered: count items per list and level; a shallower item restarts the deeper counts.
    const counts = this.counters.get(numId) ?? [];
    counts[level] = (counts[level] ?? 0) + 1;
    counts.length = level + 1;
    this.counters.set(numId, counts);
    return `${indent}${counts[level]}. `;
  }

  paragraph(p: XmlElement): Block {
    for (const drawing of descendants(p, 'drawing')) {
      void drawing;
      this.images++;
    }
    const body = inlineText(p).replace(/[ \t]+\n/g, '\n').trim();
    if (!body) return { text: '' };
    const level = this.headingLevel(p);
    if (level) return { text: `${'#'.repeat(Math.min(level, 6))} ${body.replace(/\s*\n\s*/g, ' ')}`, heading: level };
    const prefix = this.listPrefix(p);
    return prefix ? { text: `${prefix}${body.replace(/\s*\n\s*/g, ' ')}`, list: true } : { text: body };
  }

  /** A table as a pipe table; the first row is taken as the header. */
  table(tbl: XmlElement): string {
    const rows: string[][] = [];
    for (const tr of kids(tbl, 'tr')) {
      const cells: string[] = [];
      for (const tc of kids(tr, 'tc')) {
        const text = this.blocks(tc)
          .map((b) => b.text)
          .filter(Boolean)
          .join(' / ')
          .replace(/\|/g, '\\|');
        cells.push(text);
        const span = Number(firstKid(firstKid(tc, 'tcPr') ?? tc, 'gridSpan')?.attrs['val'] ?? 1);
        for (let k = 1; k < span; k++) cells.push('');
      }
      rows.push(cells);
    }
    if (rows.length === 0) return '';
    const width = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
    return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
  }

  /** The block-level content of a container (body or table cell), in order. */
  blocks(container: XmlElement): Block[] {
    const out: Block[] = [];
    for (const child of kids(container)) {
      if (child.name === 'p') out.push(this.paragraph(child));
      else if (child.name === 'tbl') out.push({ text: this.table(child) });
      else if (child.name === 'sdt' || child.name === 'sdtContent' || child.name === 'customXml') out.push(...this.blocks(child));
    }
    return out;
  }
}

/** Splits the blocks of a document into readable parts. */
function intoParts(blocks: Block[]): DocxPart[] {
  const parts: DocxPart[] = [];
  let current: Block[] = [];
  let size = 0;
  let title: string | undefined;

  const flush = () => {
    // Blocks are separated by a blank line, except consecutive list items, which stay together.
    const text = current
      .map((b, i) => (i === 0 ? b.text : `${b.list && current[i - 1].list ? '\n' : '\n\n'}${b.text}`))
      .join('')
      .trim();
    if (text) parts.push({ title, text });
    current = [];
    size = 0;
    title = undefined;
  };

  for (const block of blocks) {
    if (!block.text) continue;
    const startsSection = block.heading !== undefined && block.heading <= 1;
    if (current.length > 0 && (startsSection || size >= PART_TARGET_CHARS)) flush();
    if (block.heading !== undefined && title === undefined) title = block.text.replace(/^#+\s*/, '');
    current.push(block);
    size += block.text.length + 2;
  }
  flush();
  return parts;
}

export function readDocx(data: Uint8Array): DocxContent {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        if (!WANTED.has(file.name)) return false;
        if (file.originalSize > MAX_ENTRY_BYTES) throw new Error(`"${file.name}" is too large`);
        return true;
      },
    });
  } catch (err: any) {
    throw new Error(`not a readable .docx (${err?.message ?? err})`);
  }
  const documentXml = files['word/document.xml'];
  if (!documentXml) throw new Error('not a Word document (word/document.xml is missing)');

  const converter = new Converter(
    loadStyles(files['word/styles.xml'] && strFromU8(files['word/styles.xml'])),
    loadNumbering(files['word/numbering.xml'] && strFromU8(files['word/numbering.xml']))
  );
  const body = firstKid(parseXml(strFromU8(documentXml)), 'body');
  if (!body) throw new Error('the document has no body');
  const parts = intoParts(converter.blocks(body));

  // Reviewers' comments often hold the decisions: keep them, as a part of their own.
  if (files['word/comments.xml']) {
    const lines: string[] = [];
    for (const c of descendants(parseXml(strFromU8(files['word/comments.xml'])), 'comment')) {
      const text = converter
        .blocks(c)
        .map((b) => b.text)
        .filter(Boolean)
        .join(' ');
      if (text) lines.push(`- ${c.attrs['author'] ? `${c.attrs['author']}: ` : ''}${text}`);
    }
    if (lines.length > 0) parts.push({ title: 'Comments', text: `# Comments\n\n${lines.join('\n')}` });
  }

  const warnings: string[] = [];
  if (converter.images > 0) {
    warnings.push(`The document contains ${converter.images} image${converter.images === 1 ? '' : 's'}, which are not included (diagrams and screenshots may carry information that is missing here).`);
  }
  return { parts, warnings };
}
