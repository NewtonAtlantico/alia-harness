/**
 * Builds small, valid PDFs for tests, with no PDF library: a catalog, a page tree, one Helvetica
 * font (WinAnsi, so Portuguese accents work) and one content stream per page.
 *
 * A page is a list of text lines, or `null` for a page with no text at all (what a scan looks like
 * to a text extractor: it draws something, but there is nothing to read).
 */
export type PdfPage = string[] | null;

const escapeText = (s: string) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

export function makePdf(pages: PdfPage[]): Buffer {
  const chunks: Buffer[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (b: Buffer) => {
    chunks.push(b);
    length += b.length;
  };
  const text = (s: string) => push(Buffer.from(s, 'latin1'));
  const object = (id: number, body: Buffer | string) => {
    offsets[id] = length;
    text(`${id} 0 obj\n`);
    push(Buffer.isBuffer(body) ? body : Buffer.from(body, 'latin1'));
    text('\nendobj\n');
  };

  // Object ids: 1 catalog, 2 page tree, 3 font, then (page, content) pairs.
  const pageId = (i: number) => 4 + i * 2;
  const contentId = (i: number) => 5 + i * 2;

  text('%PDF-1.4\n');
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(' ')}] >>`);
  object(3, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  pages.forEach((lines, i) => {
    object(
      pageId(i),
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${contentId(i)} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`
    );
    // No text: draw a filled rectangle (an "image") and nothing else.
    const stream = lines
      ? `BT /F1 11 Tf 72 740 Td 14 TL ${lines.map((l) => `(${escapeText(l)}) Tj T*`).join(' ')} ET`
      : 'q 0.6 g 72 72 468 648 re f Q';
    const body = Buffer.from(stream, 'latin1');
    object(contentId(i), Buffer.concat([Buffer.from(`<< /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream', 'latin1')]));
  });

  const count = 4 + pages.length * 2;
  const xrefAt = length;
  text(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) text(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  text(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(chunks);
}

/** `n` pages of `linesPerPage` numbered lines each, e.g. "Page 3, line 7: ...". */
export function longPdf(n: number, linesPerPage: number, filler = 'lorem ipsum dolor sit amet'): Buffer {
  return makePdf(
    Array.from({ length: n }, (_, p) => Array.from({ length: linesPerPage }, (_, l) => `Page ${p + 1}, line ${l + 1}: ${filler}`))
  );
}
