/**
 * What a person who is not technical needs from a spec or a requirements document, read out of the Markdown the skills write:
 * a few lines about what the feature is, what has to be true for it to be done, what is left for later, and the first things the
 * requirements say. The skills write these sections under different headings, so the reading is by what a heading says, and
 * what cannot be found is left out rather than invented. No React, no DOM.
 */

export interface SpecDetails {
  /** What the feature is, in a sentence or two. */
  summary?: string;
  /** "Vai estar pronto quando…": the acceptance criteria. */
  criteria: string[];
  /** "Fica para depois": what is out of scope. */
  later?: string;
}

interface Section {
  heading: string;
  lines: string[];
}

const HEADING = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/;
const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;

/** The text of a line as a person reads it: no emphasis marks, links as their text, no code ticks. */
export function plain(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^>\s?/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

function sections(markdown: string): Section[] {
  const out: Section[] = [{ heading: '', lines: [] }];
  let fenced = false;
  for (const raw of markdown.replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*```/.test(raw)) fenced = !fenced;
    if (fenced) continue;
    const h = HEADING.exec(raw);
    if (h) out.push({ heading: plain(h[1]), lines: [] });
    else out[out.length - 1].lines.push(raw);
  }
  return out;
}

const items = (lines: string[]): string[] => lines.flatMap((l) => (ITEM.test(l) ? [plain(ITEM.exec(l)![1])] : [])).filter(Boolean);

/** The first paragraph of prose (not a list, a table, a quote of metadata or a line of "Chave: valor"). */
function firstParagraph(lines: string[]): string | undefined {
  const paragraph: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    const prose = !!text && !ITEM.test(line) && !/^[|>]/.test(text) && !/^[\w ]{1,24}:\s*\S/.test(text) && !/^[-=_*]{3,}$/.test(text);
    if (prose) paragraph.push(text);
    else if (paragraph.length > 0) break;
  }
  const joined = plain(paragraph.join(' '));
  return joined || undefined;
}

const CRITERIA = /crit[eé]rios?\s+de\s+aceit|acceptance|aceite|vai estar pronto|defini[cç][aã]o de pronto|definition of done/i;
const LATER = /fora\s+d[oe]\s+escopo|out of scope|n[aã]o\s+inclui|fica para depois|non-?goals|n[aã]o faz parte/i;
const ABOUT = /contexto|resumo|descri[cç][aã]o|problema?|hist[oó]ria|user story|objetivo|vis[aã]o geral|overview|background|summary/i;

/** What the spec says about itself, for the card that asks the person whether it is right. */
export function parseSpec(markdown: string): SpecDetails {
  const parts = sections(markdown);
  const find = (re: RegExp) => parts.find((p) => re.test(p.heading));

  const criteriaSection = find(CRITERIA);
  const criteria = criteriaSection ? items(criteriaSection.lines).slice(0, 8).map((c) => clip(c, 170)) : [];

  const laterSection = find(LATER);
  let later: string | undefined;
  if (laterSection) {
    const list = items(laterSection.lines);
    later = list.length > 0 ? list.map((x) => x.replace(/[.;]+$/, '')).join(', ') : firstParagraph(laterSection.lines);
    if (later) later = clip(later.endsWith('.') ? later : `${later}.`, 240);
  }

  const aboutSection = find(ABOUT);
  const about = (aboutSection && firstParagraph(aboutSection.lines)) ?? firstParagraph(parts[0].lines) ?? firstParagraph(parts.find((p) => !CRITERIA.test(p.heading) && !LATER.test(p.heading) && p.heading)?.lines ?? []);
  return { ...(about ? { summary: clip(about, 320) } : {}), criteria, ...(later ? { later } : {}) };
}

const SKIP_SECTION = /pergunta|question|lacuna|gap|em aberto|open|assun[cç][aã]o|assumption|risco|risk|premissa|fonte|source|gloss[aá]rio|hist[oó]rico/i;
const SCOPE_SECTION = /resumo|escopo|requisito|objetivo|vis[aã]o|summary|scope|requirement|funciona|functional|necessidade/i;

/** The first things the requirements say, as short lines: "O que entendemos até agora". */
export function understoodFrom(markdown: string, max = 4): string[] {
  const parts = sections(markdown).filter((p) => !SKIP_SECTION.test(p.heading));
  const pool = (parts.find((p) => SCOPE_SECTION.test(p.heading) && items(p.lines).length >= 2) ?? parts.find((p) => items(p.lines).length >= 2))?.lines ?? [];
  const lines = items(pool)
    // "REQ-001: Clientes acompanham pedidos" and "RF1 - …": the id is for the technical reader.
    .map((x) => x.replace(/^(?:[A-Z]{1,5}-?\d+[a-z]?)\s*[:.\-–—]\s*/, '').replace(/^\*{0,2}\[?[A-Z]{1,5}-?\d+\]?\*{0,2}\s*[:.\-–—]\s*/, ''))
    .filter((x) => x.split(' ').length >= 3);
  return lines.slice(0, max).map((x) => clip(x.replace(/[.;]+$/, ''), 120));
}
