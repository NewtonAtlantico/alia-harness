---
name: requirement-extraction-from-threads
description: >
  Extracts structured requirements, decisions, and open questions from an unstructured chat
  conversation or meeting transcript, turning "the requirement is buried in a thread somewhere"
  into a reviewable artifact. Use when a requirement's real source is a chat thread, call
  transcript, or email chain rather than a written ticket.
---

# Requirement Extraction from Threads

## When to use this
Use it whenever the true source of a requirement is conversational rather than written as a
ticket. If the true source is a formal document instead — a PDF, slide deck, BRD, or SOW — use
`requirement-extraction-from-documents` instead; document noise and structure are different
enough to warrant separate handling. Feed its output into `ticket-to-brief`'s format so
downstream handling stays consistent regardless of source.

## Instructions
1. Take the raw thread/transcript as input (pulled manually, or via an optional read-only
   connector to the messaging system it lives in).
2. Separate, in order: decisions actually made, requests that were made but not yet decided,
   questions that were asked but never answered, and side discussion that isn't load-bearing
   for the requirement.
3. Preserve who said what for anything that reads as a decision or commitment — attribution
   matters if it needs to be revisited later.
4. Feed the output into `ticket-to-brief`'s format so downstream handling is consistent
   regardless of whether the original source was a ticket or a thread.
5. If the thread is genuinely ambiguous about whether something was decided or just floated,
   say so explicitly rather than picking the more confident-sounding reading.

## Worked example
A 40-message client call transcript about a new feature is reduced to: 2 firm decisions, 1 open
question the client never actually answered (data retention period), and a side-thread about an
unrelated bug flagged as out of scope for this requirement.

## Edge cases / known failure modes
- Thread spans multiple unrelated topics → split into one extraction per topic rather than one
  merged, confusing output.
- Thread in a language, shorthand, or domain jargon the model handles poorly → flag lower
  confidence rather than silently guessing at meaning.

## Adapting this to your squad
Works on a raw export/paste with zero tooling, or against a live connector to whichever
messaging system the team actually uses — the extraction logic doesn't change either way.

---
### Hub catalog metadata
- sdlc_stage: Requirements
- source_evidence: implied directly by the report's opportunity mapping, which pairs a
  requirements-extraction skill with a read connector into the team's messaging tool
- priority: strategic
- tool_requirements: optional read-only MCP into the team's chat/messaging system
- est_token_footprint: medium (transcript length varies widely)
- portability_note: works with a pasted transcript with no connector at all, so it degrades
  gracefully
- maintainer: TBD
- status: draft
