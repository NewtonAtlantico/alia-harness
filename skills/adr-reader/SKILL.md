---
name: adr-reader
description: Use when making architectural decisions, choosing libraries, changing infrastructure, or any task where a prior decision might exist — consults ADRs with token-efficient cascade loading
---

# ADR Reader

Consult existing Architecture Decision Records before making decisions that may already be resolved.

## When to use

- Choosing a library, framework, or tool
- Making an architectural or infrastructure change
- Implementing a feature that touches core design choices
- Uncertain whether a decision has already been made

## Token-efficient reading protocol

Follow in order. Do not skip steps.

1. **Read `adr/INDEX.md` fully** (always short — titles and summaries only)
   - Scan for ADRs related to the current task by title, category, or keywords
   - If nothing looks relevant, stop here — no ADRs to consult

2. **Read only the header of each candidate ADR** (lines 1–25, `limit: 25`)
   - The header contains: title, status, category, tags, keywords, summary, related, date
   - Check `Status:` — superseded ADRs should be noted but not followed
   - Enough to confirm relevance in most cases
   - **Do NOT read the full body yet**

3. **Load the full body only if the header is insufficient**
   - Insufficient means: the summary is ambiguous OR you cannot determine applicability from metadata alone
   - Read full body now, before acting

4. **Apply findings before proceeding**
   - If a relevant ADR exists: follow its decision or explicitly propose superseding it
   - If no relevant ADR exists: proceed, and consider whether a new ADR should be created

> **Why this order matters:** INDEX.md is always small. Headers are ~25 lines. Full bodies can be 100–300 lines each. Speculative full reads waste tokens when the header already answers the question.
