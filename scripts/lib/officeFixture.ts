import { strToU8, zipSync } from 'fflate';

/**
 * Builds small, valid .docx and .pptx packages for tests (zipped OOXML), with the structure real
 * Office files have: Portuguese-localized Word style ids, numbering definitions, comments,
 * relationships, notes slides, hidden slides.
 */

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// ---------------------------------------------------------------------------------------- Word

export const w = {
  /** A run of text. */
  r: (text: string) => `<w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r>`,
  /** A paragraph, optionally styled or in a list. */
  p: (text: string, opts: { style?: string; numId?: number; ilvl?: number; raw?: string } = {}) => {
    const props = [
      opts.style ? `<w:pStyle w:val="${opts.style}"/>` : '',
      opts.numId !== undefined ? `<w:numPr><w:ilvl w:val="${opts.ilvl ?? 0}"/><w:numId w:val="${opts.numId}"/></w:numPr>` : '',
    ].join('');
    return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${opts.raw ?? w.r(text)}</w:p>`;
  },
  /** Heading levels use the Portuguese Word style ids (Ttulo1...), whose *names* are the English "heading 1". */
  h: (level: number, text: string) => w.p(text, { style: `Ttulo${level}` }),
  /** A table. A cell is a string, or `{ text, span }` for a merged cell, or an array of paragraphs. */
  tbl: (rows: Array<Array<string | string[] | { text: string; span: number }>>) =>
    `<w:tbl>${rows
      .map(
        (row) =>
          `<w:tr>${row
            .map((cell) => {
              if (typeof cell === 'object' && !Array.isArray(cell)) {
                return `<w:tc><w:tcPr><w:gridSpan w:val="${cell.span}"/></w:tcPr>${w.p(cell.text)}</w:tc>`;
              }
              const paras = Array.isArray(cell) ? cell : [cell];
              return `<w:tc>${paras.map((t) => w.p(t)).join('')}</w:tc>`;
            })
            .join('')}</w:tr>`
      )
      .join('')}</w:tbl>`,
};

const STYLES = `${XML}<w:styles ${W}>
  <w:style w:type="paragraph" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
  <w:style w:type="paragraph" w:styleId="Ttulo1"><w:name w:val="heading 1"/></w:style>
  <w:style w:type="paragraph" w:styleId="Ttulo2"><w:name w:val="heading 2"/></w:style>
  <w:style w:type="paragraph" w:styleId="Ttulo3"><w:name w:val="heading 3"/></w:style>
  <w:style w:type="paragraph" w:styleId="Ttulo"><w:name w:val="Title"/></w:style>
  <w:style w:type="paragraph" w:styleId="MeuCabecalho"><w:name w:val="Meu Cabecalho"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="PargrafodaLista"><w:name w:val="List Paragraph"/></w:style>
  <w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:pPr><w:numPr><w:numId w:val="1"/></w:numPr></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListNumber"><w:name w:val="List Number"/><w:pPr><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr></w:style>
  <w:style w:type="paragraph" w:styleId="ListNumberSub"><w:name w:val="List Number Sub"/><w:basedOn w:val="ListNumber"/></w:style>
</w:styles>`;

const NUMBERING = `${XML}<w:numbering ${W}>
  <w:abstractNum w:abstractNumId="0">
    <w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="1">
    <w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>
    <w:lvl w:ilvl="1"><w:numFmt w:val="lowerLetter"/></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="3"><w:abstractNumId w:val="1"/></w:num>
</w:numbering>`;

export function comments(items: Array<{ author?: string; text: string }>): string {
  return `${XML}<w:comments ${W}>${items
    .map((c, i) => `<w:comment w:id="${i}"${c.author ? ` w:author="${esc(c.author)}"` : ''}>${w.p(c.text)}</w:comment>`)
    .join('')}</w:comments>`;
}

export interface DocxOptions {
  /** Body XML (use the `w` helpers). */
  body: string;
  /** Include a comments part. */
  comments?: string;
  /** Omit styles/numbering (to test documents without them). */
  noStyles?: boolean;
  /** Extra files to add to the package. */
  extra?: Record<string, Uint8Array>;
}

export function makeDocx(opts: DocxOptions): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
    '_rels/.rels': strToU8(`${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`),
    'word/document.xml': strToU8(`${XML}<w:document ${W}><w:body>${opts.body}</w:body></w:document>`),
    ...(opts.extra ?? {}),
  };
  if (!opts.noStyles) {
    files['word/styles.xml'] = strToU8(STYLES);
    files['word/numbering.xml'] = strToU8(NUMBERING);
  }
  if (opts.comments) files['word/comments.xml'] = strToU8(opts.comments);
  return zipSync(files);
}

// ----------------------------------------------------------------------------------- PowerPoint

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

export interface SlideSpec {
  title?: string;
  /** Body paragraphs. `"> text"` is a level-1 (indented) bullet, `">> text"` level 2. */
  body?: string[];
  table?: string[][];
  notes?: string;
  hidden?: boolean;
  /** Pictures; `descr` is the alt text. */
  images?: Array<{ descr?: string }>;
  chart?: boolean;
  /** A group shape wrapping this text, to test recursion. */
  grouped?: string;
  /** Footer / slide-number placeholders (which must not appear in the text). */
  footer?: string;
}

const para = (text: string) => {
  const m = /^(>*)\s?(.*)$/.exec(text)!;
  const lvl = m[1].length;
  return `<a:p>${lvl ? `<a:pPr lvl="${lvl}"/>` : ''}<a:r><a:t>${esc(m[2])}</a:t></a:r></a:p>`;
};

const shape = (id: number, ph: string | undefined, paragraphs: string) =>
  `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr>${ph ?? ''}</p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/>${paragraphs}</p:txBody></p:sp>`;

function slideXml(s: SlideSpec): string {
  let id = 1;
  const shapes: string[] = [];
  if (s.title !== undefined) shapes.push(shape(++id, '<p:ph type="title"/>', para(s.title)));
  if (s.body) shapes.push(shape(++id, '<p:ph idx="1"/>', s.body.map(para).join('')));
  if (s.grouped) shapes.push(`<p:grpSp><p:nvGrpSpPr><p:cNvPr id="${++id}" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shape(++id, undefined, para(s.grouped))}</p:grpSp>`);
  if (s.table) {
    shapes.push(
      `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${++id}" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>${s.table
        .map((row) => `<a:tr>${row.map((cell) => `<a:tc><a:txBody><a:bodyPr/>${para(cell)}</a:txBody></a:tc>`).join('')}</a:tr>`)
        .join('')}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`
    );
  }
  if (s.chart) {
    shapes.push(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${++id}" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic></p:graphicFrame>`);
  }
  for (const img of s.images ?? []) {
    shapes.push(`<p:pic><p:nvPicPr><p:cNvPr id="${++id}" name="Picture"${img.descr ? ` descr="${esc(img.descr)}"` : ''}/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill/><p:spPr/></p:pic>`);
  }
  if (s.footer !== undefined) {
    shapes.push(shape(++id, '<p:ph type="ftr" idx="11"/>', para(s.footer)));
    shapes.push(shape(++id, '<p:ph type="sldNum" idx="12"/>', '<a:p><a:fld type="slidenum"><a:t>‹#›</a:t></a:fld></a:p>'));
  }
  return `${XML}<p:sld ${NS}${s.hidden ? ' show="0"' : ''}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>${shapes.join('')}</p:spTree></p:cSld></p:sld>`;
}

function notesXml(text: string): string {
  return `${XML}<p:notes ${NS}><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>
    ${shape(2, '<p:ph type="sldImg"/>', '')}
    ${shape(3, '<p:ph type="body" idx="1"/>', text.split('\n').map(para).join(''))}
    ${shape(4, '<p:ph type="sldNum" idx="5"/>', '<a:p><a:fld type="slidenum"><a:t>7</a:t></a:fld></a:p>')}
  </p:spTree></p:cSld></p:notes>`;
}

export interface PptxOptions {
  slides: SlideSpec[];
  /** Presentation order, as 1-based indexes into `slides` (default: as given). Tests that file numbers and order differ. */
  order?: number[];
}

export function makePptx(opts: PptxOptions): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`),
  };
  const order = opts.order ?? opts.slides.map((_, i) => i + 1);
  files['ppt/presentation.xml'] = strToU8(`${XML}<p:presentation ${NS}><p:sldIdLst>${order.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${n + 100}"/>`).join('')}</p:sldIdLst></p:presentation>`);
  files['ppt/_rels/presentation.xml.rels'] = strToU8(
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${opts.slides
      .map((_, i) => `<Relationship Id="rId${i + 101}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`)
      .join('')}</Relationships>`
  );
  opts.slides.forEach((s, i) => {
    const n = i + 1;
    files[`ppt/slides/slide${n}.xml`] = strToU8(slideXml(s));
    if (s.notes !== undefined) {
      files[`ppt/notesSlides/notesSlide${n}.xml`] = strToU8(notesXml(s.notes));
      files[`ppt/slides/_rels/slide${n}.xml.rels`] = strToU8(
        `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide${n}.xml"/></Relationships>`
      );
    }
  });
  return zipSync(files);
}
