---
name: requirement-extraction-from-documents
description: >
  Extracts structured requirements, decisions, and open questions from formal business
  documents — PDFs, slide decks (PPT), BRDs, SOWs, RFPs, or spec documents — turning a static,
  loosely-organized document into a reviewable requirements artifact. Use when the true source
  of a requirement is a formal document rather than a chat thread, ticket, or transcript.
---

# Requirement Extraction from Documents

## When to use this
Use it whenever the true source of a requirement is a formal, static document: a business
requirements document (BRD), statement of work (SOW), RFP response, vendor proposal, or a
stakeholder slide deck. Formal documents fail differently than conversation does — the noise is
boilerplate and stale slides rather than back-and-forth, and the useful signal is often in tables
and modal language ("shall" vs. "should") rather than who-said-what. If the true source is
conversational instead — a chat thread, call, or meeting — use
`requirement-extraction-from-threads` instead; if the document itself already reads as a
complete, reviewed spec, skip straight to `spec-driven-development`. Feed this skill's output
into `ticket-to-brief`'s format so downstream handling stays consistent regardless of source.

## Instructions
1. Take the extracted text of the document as input (PDF/PPT/Word converted to text, pulled
   manually or via an optional read-only connector to wherever it's stored).
2. Strip structural noise before extracting content: running headers/footers, page numbers,
   watermarks, and boilerplate legal language that carries no requirement.
3. Classify each requirement-bearing statement by its stated strength where the document uses
   modal language deliberately — "shall/must" (mandatory), "should" (recommended), "may"
   (optional) — and preserve that distinction rather than flattening everything to one priority.
4. For slide decks specifically: treat bullet fragments as compressed notes, not literal
   statements. Don't over-interpret a terse bullet into a confident requirement — flag it as
   lower-confidence if its meaning plausibly depends on unwritten speaker narration. Watch for
   consecutive or revised slides that contradict each other; decks get edited slide-by-slide and
   stale slides are easy to leave behind.
5. Capture provenance for each extracted requirement: source document name/version and page or
   slide number. Formal documents get revised, and knowing which revision a requirement came
   from matters if a newer version later supersedes it.
6. If multiple versions or drafts of the same document are in play and it's unclear which is
   authoritative, flag that explicitly rather than picking one silently.
7. Preserve tables and structured appendices (field lists, business-rule tables, requirement
   matrices) as tables in the output rather than flattening them into prose bullets — that
   structure is often the most valuable part of the source document.
8. Feed the output into `ticket-to-brief`'s format so downstream handling is consistent
   regardless of whether the original source was a ticket, thread, or document.

## Worked example
A 40-slide vendor SOW deck plus a 12-page BRD PDF arrive for a new procurement feature. Output:
a mandatory-requirements list built from the BRD's "shall" statements, a separate lower-confidence
set of goals inferred from terse slide bullets, a flagged contradiction (slide 22 marks a
capability out of scope; slide 31's revision-history note says it was added back in), and a note
that the BRD's page-8 requirements table should be preserved as a table in the brief rather than
prose.

## Edge cases / known failure modes
- Scanned/image-only PDF with no clean extractable text → flag that OCR was needed and that text
  quality is uncertain, rather than treating the extraction as clean.
- PPT where critical context lives only in speaker notes, not the visible slide text → flag as
  likely lost context and note that speaker notes should be requested if reachable.
- Very large document (100+ pages) → extract section-by-section, output a running log rather than
  attempting the whole document in one pass.
- Multiple conflicting versions of the same document floating around → flag the ambiguity on
  which is authoritative rather than silently picking one.
- Document that's mostly legal/contractual boilerplate with requirements buried in an appendix →
  don't let volume dilute focus; scope directly to the requirement-bearing sections.

## Adapting this to your squad
Works on a manually exported/converted text of the PDF or PPT with zero tooling, or against a
read-only connector to wherever source documents live (SharePoint, Drive, Confluence) — the
extraction logic doesn't change either way.

---
### Hub catalog metadata
- sdlc_stage: Requirements
- source_evidence: `(gap-fill — not sourced from the original opportunity report)`: added because
  the existing requirement-analysis skills cover tickets, chat/transcripts, and legacy code, but
  none covered formal PDF/PPT business documents (BRDs, SOWs, stakeholder decks)
- priority: TBD
- tool_requirements: none (optional: read-only connector to wherever source documents are
  stored, e.g. SharePoint/Drive/Confluence; a PDF/PPT-to-text conversion step upstream)
- est_token_footprint: medium-high (formal documents run long; scope section-by-section for
  large ones)
- portability_note: pure prompting + a fixed output template once text is extracted from the
  document; no vendor-specific features
- maintainer: TBD
- status: draft
