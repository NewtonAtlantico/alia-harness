import { unzipSync, strFromU8 } from 'fflate';
import { XmlElement, descendants, firstKid, kids, ownText, parseXml } from './xml.js';

/**
 * PowerPoint decks (.pptx) as text, one entry per slide in presentation order: the title, the
 * text of every shape, tables as pipe tables, image descriptions, and the **speaker notes**.
 * Decks whose content lives in the notes are common, so the notes are never dropped.
 *
 * Not extracted: text inside SmartArt diagrams and charts (they are noted as present), comments.
 */

export interface PptxSlide {
  /** Slide text, notes included (after a `Notes:` line). Empty when the slide has neither. */
  text: string;
  hasNotes: boolean;
  hidden: boolean;
  /** Pictures on the slide that have no description (their content is not available as text). */
  undescribedImages: number;
}

export interface PptxContent {
  slides: PptxSlide[];
  warnings: string[];
}

const MAX_ENTRY_BYTES = 40 * 1024 * 1024;

const wanted = (name: string) =>
  name === 'ppt/presentation.xml' ||
  name === 'ppt/_rels/presentation.xml.rels' ||
  /^ppt\/slides\/slide\d+\.xml$/.test(name) ||
  /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/.test(name) ||
  /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(name);

/** `Target` of every relationship, by Id. Targets are relative to the file the rels belong to. */
function relationships(xml: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  for (const r of descendants(parseXml(xml), 'Relationship')) {
    if (r.attrs['Id'] && r.attrs['Target']) map.set(r.attrs['Id'], r.attrs['Target']);
  }
  return map;
}

/** Resolves a relationship target against the folder of the part that owns it ("../notesSlides/x.xml"). */
function resolveTarget(fromDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1);
  const parts = fromDir.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg && seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

/** The text of one DrawingML paragraph (`a:p`). */
function paragraphText(p: XmlElement): string {
  let out = '';
  for (const c of p.children) {
    if (typeof c === 'string') continue;
    if (c.name === 'r' || c.name === 'fld') out += kids(c, 't').map(ownText).join('');
    else if (c.name === 'br') out += '\n';
  }
  return out;
}

function textBody(txBody: XmlElement): string[] {
  const lines: string[] = [];
  for (const p of kids(txBody, 'p')) {
    const text = paragraphText(p).replace(/[ \t]+\n/g, '\n').trim();
    if (!text) continue;
    const level = Number(firstKid(p, 'pPr')?.attrs['lvl'] ?? 0);
    lines.push(level > 0 ? `${'  '.repeat(level - 1)}- ${text.replace(/\n/g, ' ')}` : text);
  }
  return lines;
}

function pipeTable(tbl: XmlElement): string {
  const rows = kids(tbl, 'tr').map((tr) =>
    kids(tr, 'tc').map((tc) => {
      const body = firstKid(tc, 'txBody');
      return (body ? textBody(body).join(' / ') : '').replace(/\|/g, '\\|');
    })
  );
  if (rows.length === 0) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r: string[]) => `| ${[...r, ...Array(width - r.length).fill('')].join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

function placeholderType(sp: XmlElement): string | undefined {
  const nv = firstKid(sp, 'nvSpPr');
  const ph = nv && firstKid(firstKid(nv, 'nvPr') ?? nv, 'ph');
  return ph ? ph.attrs['type'] ?? 'body' : undefined;
}

interface Walked {
  title?: string;
  lines: string[];
  undescribedImages: number;
}

/** Walks a shape tree in order, collecting the title and all text. */
function walkShapes(container: XmlElement, into: Walked): void {
  for (const shape of kids(container)) {
    switch (shape.name) {
      case 'sp': {
        const type = placeholderType(shape);
        if (type === 'sldNum' || type === 'dt' || type === 'ftr') break; // slide number, date, footer
        const body = firstKid(shape, 'txBody');
        if (!body) break;
        const lines = textBody(body);
        if (lines.length === 0) break;
        if ((type === 'title' || type === 'ctrTitle') && into.title === undefined) {
          into.title = lines.join(' ');
        } else {
          into.lines.push(...lines);
        }
        break;
      }
      case 'graphicFrame': {
        const tbls = descendants(shape, 'tbl');
        if (tbls.length > 0) for (const t of tbls) into.lines.push(pipeTable(t));
        else if (descendants(shape, 'chart').length > 0) into.lines.push('[chart]');
        break;
      }
      case 'pic': {
        const descr = firstKid(firstKid(shape, 'nvPicPr') ?? shape, 'cNvPr')?.attrs['descr']?.trim();
        if (descr) into.lines.push(`[image: ${descr}]`);
        else into.undescribedImages++;
        break;
      }
      case 'grpSp':
        walkShapes(shape, into);
        break;
      case 'AlternateContent': {
        const choice = firstKid(shape, 'Choice');
        if (choice) walkShapes(choice, into);
        break;
      }
    }
  }
}

function notesText(xml: string): string {
  const tree = firstKid(firstKid(parseXml(xml), 'cSld') ?? parseXml(xml), 'spTree');
  if (!tree) return '';
  const lines: string[] = [];
  for (const sp of kids(tree, 'sp')) {
    const type = placeholderType(sp);
    if (type !== 'body') continue; // not the slide image, slide number, or header/footer placeholders
    const body = firstKid(sp, 'txBody');
    if (body) lines.push(...textBody(body));
  }
  return lines.join('\n');
}

export function readPptx(data: Uint8Array): PptxContent {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data, {
      filter: (file) => {
        if (!wanted(file.name)) return false;
        if (file.originalSize > MAX_ENTRY_BYTES) throw new Error(`"${file.name}" is too large`);
        return true;
      },
    });
  } catch (err: any) {
    throw new Error(`not a readable .pptx (${err?.message ?? err})`);
  }
  const str = (name: string) => (files[name] ? strFromU8(files[name]) : undefined);
  if (!files['ppt/presentation.xml']) throw new Error('not a PowerPoint deck (ppt/presentation.xml is missing)');

  // Presentation order: sldIdLst names relationships; fall back to the numbers in the file names.
  let slidePaths: string[] = [];
  const presentation = parseXml(str('ppt/presentation.xml')!);
  const rels = relationships(str('ppt/_rels/presentation.xml.rels'));
  for (const id of descendants(presentation, 'sldId')) {
    const target = rels.get(id.attrs['id'] ?? '');
    if (target) slidePaths.push(resolveTarget('ppt', target));
  }
  slidePaths = slidePaths.filter((p) => files[p]);
  if (slidePaths.length === 0) {
    slidePaths = Object.keys(files)
      .filter((f) => /^ppt\/slides\/slide\d+\.xml$/.test(f))
      .sort((a, b) => Number(/(\d+)\.xml$/.exec(a)![1]) - Number(/(\d+)\.xml$/.exec(b)![1]));
  }

  const slides: PptxSlide[] = [];
  for (const path of slidePaths) {
    const root = parseXml(strFromU8(files[path]));
    const walked: Walked = { lines: [], undescribedImages: 0 };
    const tree = firstKid(firstKid(root, 'cSld') ?? root, 'spTree');
    if (tree) walkShapes(tree, walked);

    // Speaker notes: the slide's relationships point at its notes part.
    let notes = '';
    const slideDir = path.slice(0, path.lastIndexOf('/'));
    const relsPath = `${slideDir}/_rels/${path.slice(path.lastIndexOf('/') + 1)}.rels`;
    for (const target of relationships(str(relsPath)).values()) {
      if (!/notesSlide/.test(target)) continue;
      const notesPath = resolveTarget(slideDir, target);
      if (files[notesPath]) notes = notesText(strFromU8(files[notesPath]));
    }

    const lines = [...(walked.title ? [`# ${walked.title}`] : []), ...walked.lines];
    const body = lines.join('\n');
    slides.push({
      text: [body, notes ? `Notes:\n${notes}` : ''].filter(Boolean).join('\n\n'),
      hasNotes: notes.length > 0,
      hidden: root.attrs['show'] === '0',
      undescribedImages: walked.undescribedImages,
    });
  }

  const warnings: string[] = [];
  const imageOnly = slides.flatMap((s, i) => (s.text === '' && s.undescribedImages > 0 ? [i + 1] : []));
  if (imageOnly.length > 0) {
    warnings.push(`Slide${imageOnly.length === 1 ? '' : 's'} ${imageOnly.slice(0, 20).join(', ')} contain only images with no description: their content is not available as text.`);
  }
  const hidden = slides.flatMap((s, i) => (s.hidden ? [i + 1] : []));
  if (hidden.length > 0) warnings.push(`Slide${hidden.length === 1 ? ' is' : 's are'} hidden in the deck: ${hidden.slice(0, 20).join(', ')}.`);
  return { slides, warnings };
}
