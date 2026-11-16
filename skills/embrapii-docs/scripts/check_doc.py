#!/usr/bin/env python3
"""Verifica documentos EMBRAPII gerados em Markdown/texto.

Uso: python -I check_doc.py ARQUIVO [ARQUIVO ...]

Blocos com limite de caracteres são delimitados por comentários:

    <!-- limite: 5000 -->
    texto da narrativa
    <!-- /limite -->

A contagem é de caracteres com espaços, sem quebras de linha (como o Word), e ignora a
marcação Markdown (**, `, #, marcadores de lista).

Saída: uma linha por bloco (OK / ATENCAO a partir de 95% / ESTOUROU) e avisos sobre
{{placeholders}} não resolvidos, CPF e e-mails soltos e frases que contrariam o
enquadramento TRL 3-6 do PT. Código de saída 1 se algum bloco passar do limite.
"""
import re
import sys
from pathlib import Path

BLOCK = re.compile(r"<!--\s*limite:\s*(\d+)\s*-->(.*?)<!--\s*/limite\s*-->", re.S)
PLACEHOLDER = re.compile(r"\{\{[^}]*\}\}")
CPF = re.compile(r"\b\d{3}\.\d{3}\.\d{3}-\d{2}\b")
EMAIL = re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b")
HTML_COMMENT = re.compile(r"<!--.*?-->", re.S)
TRL_PHRASES = [
    r"pronto[a]? para (a )?produ[cç][aã]o",
    r"production[- ]ready",
    r"pronto[a]? para (uso )?comercial",
    r"solu[cç][aã]o comercial",
    r"comercializ",
    r"implantad[oa] em produ[cç][aã]o",
]
TRL = re.compile("|".join(TRL_PHRASES), re.I)

# Estilo do Relatório de Execução Física (feedback do modelo aceito): narrativa corrida, sem
# subtítulos, linguagem institucional e não de engenharia. Avisos, nunca falha.
NARRATIVE_LINTS = [
    (r"^\s*\*\*[^*\n]{2,60}\*\*", "rótulo/subtítulo em negrito na narrativa (use bloco corrido e cronológico, sem subtítulos)"),
    (r"pend[eê]ncias desta macroentrega", "subseção 'Pendências' fora do modelo (pendências vão em Divergências)"),
    (r"valida[cç][aã]o formal.{0,40}(ser[aá]|ficar[aá]).{0,20}registrada", "fecho 'validação ainda será registrada' (use a fórmula de entregáveis e validação, ou {{ }} se não confirmada)"),
    (r"\b\d+\s+testes\b", "contagem de testes (estilo de engenharia; fica nos documentos técnicos)"),
    (r"\b(endpoint|schema|esquema estrela|ADRs?|SQLite|PostgreSQL|Angular|\.NET|API REST|contêineres?)\b", "jargão técnico na narrativa (explique em linguagem de negócio ou remova)"),
]
BODY_LINTS = [
    (r"\(narrativa abaixo\)", "narrativa fora da célula (deve ficar dentro da tabela 'Atividades / Data de aceitação')"),
    (r"MACROENTREGA:[^\n]*\s/\s", "atividades no título da ME com prefixo '/' (use lista de marcadores)"),
    (r"\bfaltam\b[^\n]{0,80}\b(testes|documenta[cç][aã]o|repasse|encerramento)", "status no título da ME (liste as atividades do PT; o que falta vai em Divergências)"),
]
DIVERGENCIAS = re.compile(r"DIVERG[ÊE]NCIAS EM RELA[ÇC][ÃA]O AO PLANEJADO\s*\n(.{0,1500})", re.S)
LIST_LINE = re.compile(r"^\s*(\d+[.)]|[-*])\s+", re.M)


def lint(text: str, rules, label: str) -> None:
    for pat, msg in rules:
        for m in re.finditer(pat, text, re.I | re.M):
            line = text.count("\n", 0, m.start()) + 1
            print(f"  ESTILO: {label} (linha {line} do trecho): {msg}")
            break


def clean(text: str) -> str:
    text = re.sub(r"^\s*(?:[-*>]|\d+\.|#+)\s+", "", text, flags=re.M)
    text = text.replace("**", "").replace("__", "").replace("`", "")
    return text.replace("\r", "").replace("\n", "").strip()


def check(path: Path) -> bool:
    raw = path.read_text(encoding="utf-8")
    ok = True
    print(f"== {path}")

    blocks = list(BLOCK.finditer(raw))
    if not blocks:
        print("  (sem blocos <!-- limite: N --> para medir)")
    for i, m in enumerate(blocks, 1):
        limit, n = int(m.group(1)), len(clean(m.group(2)))
        pct = 100 * n / limit
        if n > limit:
            status, ok = f"ESTOUROU em {n - limit}", False
        elif pct >= 95:
            status = "ATENCAO (perto do limite)"
        else:
            status = "OK"
        print(f"  bloco {i}: {n}/{limit} caracteres ({pct:.0f}%) {status}")

    body = HTML_COMMENT.sub("", raw)
    pend = sorted(set(PLACEHOLDER.findall(body)))
    if pend:
        print(f"  ATENCAO: {len(pend)} placeholder(s) não resolvido(s):")
        for p in pend[:15]:
            print(f"    {p}")
        if len(pend) > 15:
            print(f"    ... e mais {len(pend) - 15}")
    for pat, label in ((CPF, "CPF"), (EMAIL, "e-mail")):
        found = sorted(set(pat.findall(body)))
        if found:
            print(f"  ATENCAO: {label} no texto ({len(found)}): só é aceitável o e-mail corporativo de elaboradores na capa; CPF nunca. Confirme ou remova")
    for m in TRL.finditer(body):
        line = body.count("\n", 0, m.start()) + 1
        print(f"  ATENCAO: linha {line}: '{m.group(0)}' contraria o enquadramento TRL 3-6 do PT")

    for i, m in enumerate(blocks, 1):
        lint(m.group(2), NARRATIVE_LINTS, f"bloco {i}")
    lint(body, BODY_LINTS, "documento")
    div = DIVERGENCIAS.search(body)
    if div:
        text = div.group(1).split("Emitido em")[0]
        if LIST_LINE.search(text):
            print("  ESTILO: divergências em lista; o modelo aceito usa um parágrafo curto de prazo e impacto")
    return ok


def main(argv: list[str]) -> int:
    sys.stdout.reconfigure(encoding="utf-8")
    if not argv:
        print(__doc__)
        return 2
    results = [check(Path(a)) for a in argv]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
