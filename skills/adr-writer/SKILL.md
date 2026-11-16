---
name: adr-writer
description: Create consistent Architecture Decision Records and keep the index in sync
---

# ADR Writer

Create a new Architecture Decision Record following the project's token-optimized format,
then update the index inline.

## Before creating an ADR

**Token-efficient reading protocol — follow in order, do not skip steps:**

1. **Read `adr/INDEX.md` fully** (it is always short — titles and summaries only)
   - Identify the next ADR number (highest existing + 1)
   - Note which ADRs may be related to the new decision

2. **Read only the header of each related ADR** (lines 1–25, `limit: 25`)
   - The header contains: title, status, category, tags, keywords, summary, related, date
   - This is enough to detect conflicts or superseded decisions in most cases
   - **Do NOT read the full body yet**

3. **Load the full body only if the header is insufficient**
   - Insufficient means: the summary is ambiguous OR a conflict cannot be confirmed from metadata alone
   - If full body is needed, read it now before drafting

4. **Only then draft the new ADR**

> **Why this order matters:** INDEX.md is always small. ADR headers are ~25 lines. Full bodies can be 100–300 lines each. Reading full bodies speculatively wastes tokens when the header already answers the question.

## ADR structure

```text
# ADR-XXXX

Title: <one line>
Status: Proposed
Category: Architecture | Infrastructure | AI | Product
Tags: [tag1, tag2]
Keywords: word1, word2, word3
Summary: <max 3 lines>
Related: ADR-XXXX (if any)
Date: YYYY-MM-DD

---

## Context

<The situation that required a decision>

## Decision

<What was decided>

## Consequences

<Trade-offs and follow-ups>

## Alternatives Considered

<Up to 3 alternatives with brief reasoning for rejection>
```

## File placement

Place the new ADR in the matching category folder:

```text
adr/
├── architecture/   ← for architecture decisions
├── infrastructure/ ← for infra/tooling decisions
├── ai/             ← for AI/ML/LLM decisions
└── product/        ← for product/feature decisions
```

File name: `XXXX-<kebab-title>.md` (e.g. `0021-qdrant-vector-db.md`)

## After creating the ADR

Append a new row at the end of the table in `adr/INDEX.md`:

```markdown
| XXXX | Category | Title | One-line summary |
```

Do not regenerate the full file — append the row only.

If `adr/INDEX.md` does not exist yet, create it:

```markdown
# ADR Index

| ADR  | Category | Title | Summary |
|------|----------|-------|---------|
| XXXX | Category | Title | Summary |
```

> To regenerate the full INDEX from all ADR files (e.g., after a rename or bulk import),
> use `./scripts/update-adr-index.sh` (or `.\scripts\update-adr-index.ps1` on Windows).

> Provider note: editing a Markdown file is a standard file edit operation.
> See `kit/references/` for how to edit files on your provider.
