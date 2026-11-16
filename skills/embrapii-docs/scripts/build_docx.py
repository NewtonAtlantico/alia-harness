#!/usr/bin/env python3
"""Converte um documento EMBRAPII em Markdown (saída da skill) para .docx com o layout institucional.

Uso:
    python -I build_docx.py ENTRADA.md SAIDA.docx --tipo concepcao|relatorio|generico
                            [--cabecalho "Documento de Concepção"] [--logo logo.png]

Por que .docx: a equipe cola/importa os documentos no Google Docs, e o .docx é o formato que o
Google Docs importa sem perder formatação (tabelas, cabeçalho, rodapé, paginação, logo).
O .doc binário antigo não é gerado por esta biblioteca; se for realmente necessário, use
`word_finalize.ps1 -SalvarDoc` (Word instalado).

Requer: pip install python-docx

Subconjunto de Markdown aceito (o que os modelos da skill usam): títulos `##`/`###`, parágrafos,
listas `-` e `1.`, tabelas de pipe, **negrito**, tabelas HTML simples do Relatório
(<table><tr><td colspan="2">…) e comentários `<!-- -->` (descartados). `{{PLACEHOLDERS}}` saem
destacados em amarelo para ninguém esquecê-los. A linha final `Rodapé: …` do Relatório vira o
rodapé do Word.

tipos:
  concepcao  capa (logo, título, classificação, tabela de elaboradores), índice (campo TOC do
             Word com as entradas já preenchidas), cabeçalho "logo | título | N / TOTAL",
             rodapé "© … Todos os direitos reservados".
  relatorio  Anexo 10: logo no cabeçalho, rodapé institucional com endereço, versão do modelo
             e "Página N de TOTAL"; tabela da ME com a narrativa dentro da célula; assinaturas.
  generico   Termo de Aceite e demais: logo + título no cabeçalho, © no rodapé.
"""
import argparse
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK, WD_COLOR_INDEX, WD_TAB_ALIGNMENT
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

FONT = "Arial"
HERE = Path(__file__).resolve().parent
DEFAULT_LOGO = HERE.parent / "assets" / "layout" / "logo-atlantico.png"
COMMENT = re.compile(r"<!--.*?-->", re.S)
TEXT_WIDTH_CM = 16.0


# ---------------------------------------------------------------- helpers de baixo nível
def set_font(run, size=None, bold=None, italic=None, small_caps=None, color=None):
    run.font.name = FONT
    rpr = run._element.get_or_add_rPr()
    rfonts = rpr.find(qn("w:rFonts"))
    if rfonts is None:
        rfonts = OxmlElement("w:rFonts")
        rpr.append(rfonts)
    for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
        rfonts.set(qn(a), FONT)
    if size:
        run.font.size = Pt(size)
    if bold is not None:
        run.bold = bold
    if italic is not None:
        run.italic = italic
    if small_caps is not None:
        run.font.small_caps = small_caps
    if color is not None:
        run.font.color.rgb = RGBColor(*color)


INLINE = re.compile(r"(\*\*.+?\*\*|\{\{.*?\}\})")


def add_inline(par, text, size=None, bold=False, italic=False):
    """Escreve texto com **negrito** e placeholders destacados."""
    for tok in INLINE.split(text):
        if not tok:
            continue
        if tok.startswith("**") and tok.endswith("**"):
            run = par.add_run(tok[2:-2])
            set_font(run, size, True, italic)
        elif tok.startswith("{{"):
            run = par.add_run(tok)
            set_font(run, size, bold, italic)
            run.font.highlight_color = WD_COLOR_INDEX.YELLOW
        else:
            run = par.add_run(tok)
            set_font(run, size, bold or None, italic or None)


def add_field(par, instr, size=None, bold=None, cached="1"):
    def fld(kind):
        r = par.add_run()
        set_font(r, size, bold)
        c = OxmlElement("w:fldChar")
        c.set(qn("w:fldCharType"), kind)
        r._element.append(c)
        return r

    fld("begin")
    r = par.add_run()
    set_font(r, size, bold)
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = f" {instr} "
    r._element.append(it)
    fld("separate")
    r = par.add_run(cached)
    set_font(r, size, bold)
    fld("end")


def shade(cell, fill="D9D9D9"):
    tcpr = cell._element.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tcpr.append(shd)


def set_borders(table, sz=4, color="000000", inside=True):
    tblpr = table._element.tblPr
    old = tblpr.find(qn("w:tblBorders"))
    if old is not None:
        tblpr.remove(old)
    b = OxmlElement("w:tblBorders")
    edges = ["top", "left", "bottom", "right"] + (["insideH", "insideV"] if inside else [])
    for e in edges:
        el = OxmlElement(f"w:{e}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(sz))
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), color)
        b.append(el)
    tblpr.append(b)


def cell_border(cell, **edges):
    tcpr = cell._element.get_or_add_tcPr()
    b = OxmlElement("w:tcBorders")
    for e, val in edges.items():
        el = OxmlElement(f"w:{e}")
        el.set(qn("w:val"), val)
        el.set(qn("w:sz"), "6")
        el.set(qn("w:space"), "0")
        el.set(qn("w:color"), "000000")
        b.append(el)
    tcpr.append(b)


def set_widths(table, widths_cm):
    table.autofit = False
    tblpr = table._element.tblPr
    lay = OxmlElement("w:tblLayout")
    lay.set(qn("w:type"), "fixed")
    tblpr.append(lay)
    for row in table.rows:
        for i, w in enumerate(widths_cm):
            if i < len(row.cells):
                row.cells[i].width = Cm(w)


def cell_margins(table, top=60, bottom=60, left=100, right=100):
    tblpr = table._element.tblPr
    m = OxmlElement("w:tblCellMar")
    for k, v in (("top", top), ("left", left), ("bottom", bottom), ("right", right)):
        el = OxmlElement(f"w:{k}")
        el.set(qn("w:w"), str(v))
        el.set(qn("w:type"), "dxa")
        m.append(el)
    tblpr.append(m)


def keep_row_together(row, allow_split=False):
    trpr = row._tr.get_or_add_trPr()
    if not allow_split:
        el = OxmlElement("w:cantSplit")
        trpr.append(el)


def repeat_header(row):
    trpr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    trpr.append(el)


def fmt(par, align=None, before=0, after=6, line=1.15, first=None, left=None, keep_next=False):
    pf = par.paragraph_format
    if align is not None:
        par.alignment = align
    pf.space_before = Pt(before)
    pf.space_after = Pt(after)
    pf.line_spacing = line
    if first is not None:
        pf.first_line_indent = Cm(first)
    if left is not None:
        pf.left_indent = Cm(left)
    if keep_next:
        pf.keep_with_next = True


def page_break(doc):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


# ---------------------------------------------------------------- documento base e estilos
def new_document():
    doc = Document()
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21), Cm(29.7)
    sec.left_margin = sec.right_margin = Cm(2.5)
    sec.top_margin, sec.bottom_margin = Cm(3.0), Cm(2.5)
    sec.header_distance, sec.footer_distance = Cm(1.2), Cm(1.0)

    st = doc.styles["Normal"]
    st.font.name = FONT
    st.font.size = Pt(10)
    st.element.rPr.rFonts.set(qn("w:eastAsia"), FONT)
    for name, size, caps in (("Heading 1", 12, True), ("Heading 2", 11, False), ("Heading 3", 10, False)):
        h = doc.styles[name]
        h.font.name = FONT
        h.font.size = Pt(size)
        h.font.bold = True
        h.font.small_caps = caps
        h.font.color.rgb = RGBColor(0, 0, 0)
        rpr = h.element.get_or_add_rPr()
        rf = rpr.find(qn("w:rFonts"))
        if rf is None:
            rf = OxmlElement("w:rFonts")
            rpr.append(rf)
        for a in ("w:ascii", "w:hAnsi", "w:cs", "w:eastAsia"):
            rf.set(qn(a), FONT)
        for a in ("w:asciiTheme", "w:hAnsiTheme", "w:cstheme", "w:eastAsiaTheme"):
            if rf.get(qn(a)) is not None:
                del rf.attrib[qn(a)]
        h.paragraph_format.space_before = Pt(14 if name == "Heading 1" else 10)
        h.paragraph_format.space_after = Pt(6)
        h.paragraph_format.keep_with_next = True
    return doc


def add_logo(par, logo: Path, height_cm=1.1):
    if logo.exists():
        par.add_run().add_picture(str(logo), height=Cm(height_cm))


# ---------------------------------------------------------------- blocos de Markdown
def split_blocks(text):
    return [b.strip("\n") for b in re.split(r"\n\s*\n", text.strip()) if b.strip()]


def parse_pipe_table(block):
    rows = []
    for ln in block.splitlines():
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        if all(re.fullmatch(r":?-{2,}:?", c) for c in cells):
            continue
        rows.append(cells)
    return rows


def auto_widths(rows, ncol):
    """Larguras proporcionais à raiz do maior texto de cada coluna (tabelas largas, como o cronograma)."""
    import math
    lens = [min(40, max(len(r[i]) if i < len(r) else 0 for r in rows)) for i in range(ncol)]
    w = [math.sqrt(max(l, 6)) for l in lens]
    tot = sum(w)
    longest = [max((len(wd) for r in rows if i < len(r) for wd in r[i].split()), default=4) for i in range(ncol)]
    floor = [0.17 * l + 0.45 for l in longest]  # nenhuma palavra deve quebrar no meio (ex.: "Macroentrega")
    ws = [max(floor[i], TEXT_WIDTH_CM * w[i] / tot) for i in range(ncol)]
    k = TEXT_WIDTH_CM / sum(ws)
    return [x * k for x in ws]


def render_pipe_table(doc, rows, widths=None, size=9, bold_first_col=False):
    header = rows[0]
    has_header = any(c.strip() for c in header)
    data = rows if has_header else rows[1:]
    ncol = max(len(r) for r in data)
    t = doc.add_table(rows=0, cols=ncol)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_borders(t)
    cell_margins(t)
    for ri, r in enumerate(data):
        row = t.add_row()
        keep_row_together(row)
        for ci in range(ncol):
            txt = r[ci] if ci < len(r) else ""
            cell = row.cells[ci]
            p = cell.paragraphs[0]
            fmt(p, after=0, line=1.0)
            if has_header and ri == 0:
                shade(cell)
                p.alignment = WD_ALIGN_PARAGRAPH.CENTER
                add_inline(p, txt, size, bold=True)
            else:
                add_inline(p, txt, size, bold=bold_first_col and ci == 0)
        if has_header and ri == 0:
            repeat_header(row)
    if widths is None:
        widths = auto_widths(data, ncol)
    set_widths(t, widths)
    doc.add_paragraph().paragraph_format.space_after = Pt(4)
    return t


def render_list_item(doc, line, size=10):
    m = re.match(r"^\s*(\d+)[.)]\s+(.*)", line)
    if m:  # numeração manual, para não herdar numeração contínua entre listas
        p = doc.add_paragraph()
        fmt(p, WD_ALIGN_PARAGRAPH.JUSTIFY, after=3, left=1.25, first=-0.75)
        add_inline(p, f"{m.group(1)}.\t" + m.group(2), size)
        p.paragraph_format.tab_stops.add_tab_stop(Cm(1.25))
        return p
    p = doc.add_paragraph(style="List Bullet")
    fmt(p, WD_ALIGN_PARAGRAPH.JUSTIFY, after=3)
    add_inline(p, re.sub(r"^\s*[-*]\s+", "", line), size)
    return p


def render_block(doc, block, indent_first=True):
    lines = block.splitlines()
    if all(re.match(r"^\s*([-*]|\d+[.)])\s+", l) for l in lines):
        for l in lines:
            render_list_item(doc, l)
        return
    if block.lstrip().startswith("|"):
        rows = parse_pipe_table(block)
        wide = max(len(r) for r in rows) >= 5
        render_pipe_table(doc, rows, size=8 if wide else 9)
        return
    ref = all(re.match(r"^\[\d+\]", l) for l in lines)
    for l in lines:
        p = doc.add_paragraph()
        if ref:
            fmt(p, WD_ALIGN_PARAGRAPH.JUSTIFY, after=4)
        else:
            fmt(p, WD_ALIGN_PARAGRAPH.JUSTIFY, first=1.25 if indent_first else None)
        add_inline(p, l, 10)


def render_heading(doc, line):
    m = re.match(r"^(#{2,4})\s+(.*)", line)
    level = len(m.group(1)) - 1
    txt = re.sub(r"^(\d+(?:\.\d+)*)\s+", r"\1\t", m.group(2))
    p = doc.add_paragraph(style=f"Heading {level}")
    p.paragraph_format.tab_stops.add_tab_stop(Cm(1.0 if level == 1 else 1.25))
    add_inline(p, txt)
    return p


def render_body(doc, blocks):
    for b in blocks:
        first = b.splitlines()[0]
        if first.startswith("#"):
            render_heading(doc, first)
            rest = "\n".join(b.splitlines()[1:]).strip()
            if rest:
                render_body(doc, split_blocks(rest))
        else:
            render_block(doc, b)


# ---------------------------------------------------------------- cabeçalho e rodapé
def header_logo_title(section, logo, title, first_page_logo_only=False):
    hdr = section.header
    hdr.is_linked_to_previous = False
    p = hdr.paragraphs[0]
    fmt(p, after=2)
    add_logo(p, logo)
    if title:
        p2 = hdr.add_paragraph()
        fmt(p2, after=0)
        ts = p2.paragraph_format.tab_stops
        ts.add_tab_stop(Cm(TEXT_WIDTH_CM / 2), WD_TAB_ALIGNMENT.CENTER)
        ts.add_tab_stop(Cm(TEXT_WIDTH_CM), WD_TAB_ALIGNMENT.RIGHT)
        r = p2.add_run("\t" + title + "\t")
        set_font(r, 9)
        add_field(p2, "PAGE", 9)
        r = p2.add_run(" / ")
        set_font(r, 9)
        add_field(p2, "NUMPAGES", 9)
        pPr = p2._p.get_or_add_pPr()
        bd = OxmlElement("w:pBdr")
        bt = OxmlElement("w:bottom")
        for k, v in (("val", "single"), ("sz", "4"), ("space", "4"), ("color", "808080")):
            bt.set(qn(f"w:{k}"), v)
        bd.append(bt)
        pPr.append(bd)


def footer_text(section, text, bold=True, size=9):
    ft = section.footer
    ft.is_linked_to_previous = False
    p = ft.paragraphs[0]
    fmt(p, WD_ALIGN_PARAGRAPH.CENTER, after=0)
    r = p.add_run(text)
    set_font(r, size, bold)


# ---------------------------------------------------------------- tipo: concepção
def build_concepcao(doc, text, logo, cabecalho):
    blocks = split_blocks(COMMENT.sub("", text))
    idx = next(i for i, b in enumerate(blocks) if b.strip().upper().startswith("ÍNDICE"))
    cover, rest = blocks[:idx], blocks[idx + 1:]
    # a lista estática do índice no .md é descartada: o índice do Word nasce dos títulos
    start = next(i for i, b in enumerate(rest) if b.lstrip().startswith("#"))
    rest = rest[start:]
    sec = doc.sections[0]
    sec.different_first_page_header_footer = True

    copyright_line = next((b for b in cover if b.startswith("©")), "© Instituto Atlântico – Todos os direitos reservados")
    title = cover[0].replace("**", "")
    doc_name = cover[1].replace("**", "").strip()
    resp_line = cover[2]
    table_rows = parse_pipe_table(cover[3])
    resp = re.search(r"Respons[aá]vel:\s*(.*?)(?:\s{2,}|\s*Classifica|$)", resp_line).group(1)
    classif = re.search(r"Classifica[cç][aã]o:\s*(.*)", resp_line).group(1).strip()

    # cabeçalhos/rodapés
    fh = sec.first_page_header
    fh.is_linked_to_previous = False
    add_logo(fh.paragraphs[0], logo, 1.3)
    header_logo_title(sec, logo, cabecalho)
    for f in (sec.first_page_footer, sec.footer):
        f.is_linked_to_previous = False
        p = f.paragraphs[0]
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, after=0)
        add_inline(p, copyright_line, 9, bold=True)

    # capa
    p = doc.add_paragraph()
    fmt(p, WD_ALIGN_PARAGRAPH.CENTER, before=110, after=70)
    add_inline(p, title, 24, bold=True)
    p = doc.add_paragraph()
    fmt(p, WD_ALIGN_PARAGRAPH.CENTER, before=0, after=80)
    nice = doc_name.title().replace(" De ", " de ").replace(" Da ", " da ") if doc_name.isupper() else doc_name
    r = p.add_run(nice)
    set_font(r, 14, True, small_caps=True)
    p = doc.add_paragraph()
    fmt(p, WD_ALIGN_PARAGRAPH.RIGHT, before=0, after=2)
    add_inline(p, classif, 12, bold=True)

    t = doc.add_table(rows=0, cols=3)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_borders(t)
    cell_margins(t)
    row = t.add_row()
    a = row.cells[0].merge(row.cells[1])
    p = a.paragraphs[0]
    fmt(p, after=0, line=1.0)
    r = p.add_run("Responsável:  ")
    set_font(r, 9, True)
    add_inline(p, resp, 9)
    p = row.cells[2].paragraphs[0]
    fmt(p, after=0, line=1.0)
    r = p.add_run("Modelo:")
    set_font(r, 9, True)
    row = t.add_row()
    for ci, h in enumerate(("Elaborador(es):", "e-mail", "Ramal")):
        p = row.cells[ci].paragraphs[0]
        fmt(p, after=0, line=1.0)
        r = p.add_run(h)
        set_font(r, 9, True)
    for r_ in table_rows[1:]:
        row = t.add_row()
        for ci in range(3):
            p = row.cells[ci].paragraphs[0]
            fmt(p, after=0, line=1.0)
            add_inline(p, r_[ci] if ci < len(r_) else "", 9)
    set_widths(t, [6.6, 6.9, 2.5])
    page_break(doc)

    # índice (campo TOC com entradas já preenchidas; o Word/Google mantêm e o Word atualiza)
    p = doc.add_paragraph()
    fmt(p, before=14, after=10)
    r = p.add_run("Índice")
    set_font(r, 12, True, small_caps=True)
    entries = []
    for b in rest:
        for ln in b.splitlines():
            m = re.match(r"^(#{2,3})\s+(.*)", ln)
            if m:
                entries.append((len(m.group(1)) - 1, re.sub(r"^(\d+(?:\.\d+)*)\s+", r"\1\t", m.group(2))))
    add_toc(doc, entries)
    page_break(doc)

    render_body(doc, rest)


def add_toc(doc, entries):
    """Campo TOC multi-parágrafo. O resultado em cache são as próprias entradas (sem nº de página);
    o Word troca por páginas reais ao atualizar o campo (word_finalize.ps1 faz isso)."""
    paras = []
    for level, txt in entries:
        p = doc.add_paragraph()
        fmt(p, after=3, left=0.0 if level == 1 else 0.8)
        p.paragraph_format.tab_stops.add_tab_stop(Cm(1.3 if level == 1 else 2.2))
        r = p.add_run(txt)
        set_font(r, 10, level == 1)
        paras.append(p)

    def fld(par, kind, first=False):
        r = OxmlElement("w:r")
        c = OxmlElement("w:fldChar")
        c.set(qn("w:fldCharType"), kind)
        r.append(c)
        return r

    first, last = paras[0], paras[-1]
    begin = fld(first, "begin")
    instr = OxmlElement("w:r")
    it = OxmlElement("w:instrText")
    it.set(qn("xml:space"), "preserve")
    it.text = ' TOC \\o "1-2" \\h \\z \\u '
    instr.append(it)
    sep = fld(first, "separate")
    first_runs = first._p.findall(qn("w:r"))
    first_runs[0].addprevious(begin)
    first_runs[0].addprevious(instr)
    first_runs[0].addprevious(sep)
    last._p.append(fld(last, "end"))


# ---------------------------------------------------------------- tipo: relatório
class TableParser(HTMLParser):
    """Lê o <table> do Relatório: linhas → células {tag, colspan, texto}."""

    def __init__(self):
        super().__init__()
        self.rows, self.cur, self.cell, self.attrs, self.tag = [], None, None, {}, None

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self.cur = []
        elif tag in ("td", "th"):
            self.cell, self.tag, self.attrs = [], tag, dict(attrs)

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self.cell is not None:
            self.cur.append({"tag": self.tag, "colspan": int(self.attrs.get("colspan", 1)),
                             "text": "".join(self.cell).strip()})
            self.cell = None
        elif tag == "tr" and self.cur is not None:
            self.rows.append(self.cur)
            self.cur = None

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append(data)


def fill_cell(cell, text, size=9.5, align=WD_ALIGN_PARAGRAPH.JUSTIFY):
    text = COMMENT.sub("", text)
    first = True
    for b in split_blocks(text):
        for ln in b.splitlines():
            p = cell.paragraphs[0] if first else cell.add_paragraph()
            first = False
            if re.match(r"^\s*[-*]\s+", ln):
                fmt(p, WD_ALIGN_PARAGRAPH.LEFT, after=2, left=0.9, first=-0.4, line=1.1)
                add_inline(p, "•\t" + re.sub(r"^\s*[-*]\s+", "", ln), size)
                p.paragraph_format.tab_stops.add_tab_stop(Cm(0.9))
            else:
                fmt(p, align, after=6, line=1.15)
                add_inline(p, ln, size)


def render_me_table(doc, html):
    tp = TableParser()
    tp.feed(html)
    rows = tp.rows
    t = doc.add_table(rows=0, cols=2)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    set_borders(t)
    cell_margins(t, 80, 80, 120, 120)
    for r in rows:
        row = t.add_row()
        if len(r) == 1 and r[0]["colspan"] == 2:
            c = row.cells[0].merge(row.cells[1])
            fill_cell(c, r[0]["text"], 10, WD_ALIGN_PARAGRAPH.LEFT)
            shade(c, "F2F2F2")
            keep_row_together(row)
        elif all(c["tag"] == "th" for c in r):
            for ci, c in enumerate(r):
                shade(row.cells[ci])
                p = row.cells[ci].paragraphs[0]
                fmt(p, WD_ALIGN_PARAGRAPH.CENTER, after=0, line=1.0)
                add_inline(p, c["text"], 9, bold=True)
            keep_row_together(row)
        else:
            fill_cell(row.cells[0], r[0]["text"])
            p = row.cells[1].paragraphs[0]
            fmt(p, WD_ALIGN_PARAGRAPH.CENTER, after=0, line=1.0)
            add_inline(p, r[1]["text"], 9.5)
            keep_row_together(row, allow_split=True)  # narrativa longa pode quebrar de página
    set_widths(t, [12.6, 3.4])
    doc.add_paragraph().paragraph_format.space_after = Pt(6)


def build_relatorio(doc, text, logo):
    footer_raw = None
    m = re.search(r"^Rodapé:\s*(.*)$", text, re.M)
    if m:
        footer_raw = m.group(1).strip()
        text = text.replace(m.group(0), "")
    text = COMMENT.sub("", text)
    htmls = re.findall(r"<table>.*?</table>", text, re.S)
    for i, h in enumerate(htmls):
        text = text.replace(h, f"\n\n@@ME{i}@@\n\n", 1)
    blocks = split_blocks(text)

    sec = doc.sections[0]
    header_logo_title(sec, logo, None)
    if footer_raw:
        parts = [p.strip() for p in footer_raw.split("·")]
        addr = [p for p in parts if not p.lower().startswith("página")]
        ft = sec.footer
        ft.is_linked_to_previous = False
        p = ft.paragraphs[0]
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, after=2, line=1.0)
        add_inline(p, " · ".join(addr[:-1]) if len(addr) > 1 else addr[0], 7)
        p2 = ft.add_paragraph()
        fmt(p2, WD_ALIGN_PARAGRAPH.CENTER, after=0, line=1.0)
        r = p2.add_run("Página ")
        set_font(r, 7.5)
        add_field(p2, "PAGE", 7.5)
        r = p2.add_run(" de ")
        set_font(r, 7.5)
        add_field(p2, "NUMPAGES", 7.5)
        if len(addr) > 1:
            add_inline(p2, "    " + addr[-1], 7.5)

    # bloco de título (3 primeiras linhas) e campos do cabeçalho
    title_block = blocks[0].splitlines()
    for i, ln in enumerate(title_block):
        p = doc.add_paragraph()
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, before=6 if i == 0 else 0, after=2 if i < 2 else 12, line=1.0)
        add_inline(p, ln, 14 if i == 0 else 11, bold=True)
    div_seen = False
    for b in blocks[1:]:
        lines = b.splitlines()
        if b.startswith("@@ME"):
            render_me_table(doc, htmls[int(re.search(r"\d+", b).group())])
        elif b.strip().upper().startswith("DIVERGÊNCIAS"):
            p = doc.add_paragraph()
            fmt(p, WD_ALIGN_PARAGRAPH.LEFT, before=10, after=6, keep_next=True)
            add_inline(p, b.strip(), 11, bold=True)
            div_seen = True
        elif b.lstrip().startswith("|"):
            rows = parse_pipe_table(b)
            render_pipe_table(doc, rows, widths=[5.0, 11.0], size=9.5, bold_first_col=True)
        elif lines[0].startswith("Emitido em"):
            p = doc.add_paragraph()
            fmt(p, WD_ALIGN_PARAGRAPH.CENTER, before=18, after=24)
            add_inline(p, b.replace("\n", " "), 10)
        elif div_seen and re.search(r"Unidade EMBRAPII|CRC:", b):
            sign_blocks = [b]
            # assinaturas consecutivas viram colunas
            render_signature(doc, sign_blocks)
        elif not div_seen and re.match(r"^[A-Za-zÀ-ú ]+:\s", lines[0]):
            for ln in lines:
                p = doc.add_paragraph()
                fmt(p, WD_ALIGN_PARAGRAPH.LEFT, after=2, line=1.1)
                label, _, val = ln.partition(":")
                if val and label.strip() in ("Projeto", "Responsável", "CPF", "Período de Vigência do Projeto",
                                              "Período de Referência", "Contador", "CRC"):
                    add_inline(p, f"**{label}:**{val}", 10)
                else:
                    add_inline(p, ln, 10, bold=True)
            doc.paragraphs[-1].paragraph_format.space_after = Pt(10)
        else:
            for ln in lines:
                p = doc.add_paragraph()
                fmt(p, WD_ALIGN_PARAGRAPH.JUSTIFY, after=6)
                add_inline(p, ln, 10)
    merge_signatures(doc)


_SIGN = []


def render_signature(doc, sign_blocks):
    _SIGN.extend(sign_blocks)
    p = doc.add_paragraph()
    p.text = "@@SIGN@@"


def merge_signatures(doc):
    """Troca os marcadores @@SIGN@@ por uma tabela sem bordas (assinantes lado a lado)."""
    marks = [p for p in doc.paragraphs if p.text == "@@SIGN@@"]
    if not marks:
        return
    first = marks[0]
    n = len(_SIGN)
    t = doc.add_table(rows=1, cols=2 * n - 1)  # colunas ímpares são espaçadores (linhas de assinatura separadas)
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    for ci, blk in enumerate(_SIGN):
        c = t.rows[0].cells[2 * ci]
        cell_border(c, top="single")
        for li, ln in enumerate(blk.splitlines()):
            p = c.paragraphs[0] if li == 0 else c.add_paragraph()
            fmt(p, WD_ALIGN_PARAGRAPH.CENTER, before=4 if li == 0 else 0, after=0, line=1.0)
            add_inline(p, ln, 10, bold=(li == 0))
    gap = 1.0
    cw = (TEXT_WIDTH_CM - gap * (n - 1)) / n
    set_widths(t, [w for i in range(n) for w in ([cw] + ([gap] if i < n - 1 else []))])
    first._p.addprevious(t._tbl)
    for p in marks:
        p._p.getparent().remove(p._p)


# ---------------------------------------------------------------- tipo: genérico
def build_generico(doc, text, logo, cabecalho):
    blocks = split_blocks(COMMENT.sub("", text))
    sec = doc.sections[0]
    header_logo_title(sec, logo, cabecalho)
    footer_text(sec, "© Instituto Atlântico – Todos os direitos reservados")
    first = blocks[0].splitlines()[0]
    if not first.startswith("#"):
        p = doc.add_paragraph()
        fmt(p, WD_ALIGN_PARAGRAPH.CENTER, before=6, after=14)
        add_inline(p, first, 14, bold=True)
        blocks = blocks[1:]
    render_body(doc, blocks)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("entrada", type=Path)
    ap.add_argument("saida", type=Path)
    ap.add_argument("--tipo", choices=("concepcao", "relatorio", "generico"), required=True)
    ap.add_argument("--cabecalho", default=None, help="texto central do cabeçalho (padrão: nome do documento)")
    ap.add_argument("--logo", type=Path, default=DEFAULT_LOGO)
    a = ap.parse_args()

    text = a.entrada.read_text(encoding="utf-8")
    doc = new_document()
    if a.tipo == "concepcao":
        build_concepcao(doc, text, a.logo, a.cabecalho or "Documento de Concepção")
    elif a.tipo == "relatorio":
        build_relatorio(doc, text, a.logo)
    else:
        build_generico(doc, text, a.logo, a.cabecalho or a.entrada.stem)
    a.saida.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(a.saida))
    left = sorted(set(re.findall(r"\{\{[^}]*\}\}", COMMENT.sub("", text))))
    print(f"gerado: {a.saida}")
    if left:
        print(f"ATENCAO: {len(left)} placeholder(s) destacados em amarelo no documento:")
        for x in left:
            print(f"  {x}")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
