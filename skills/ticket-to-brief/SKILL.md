---
name: ticket-to-brief
description: >
  Converts a raw ticket, email thread, or chat conversation about a requested feature or
  bug into a structured markdown brief (context, acceptance criteria, open questions, risks).
  Use whenever a developer receives ambiguous or thin requirements and needs a clear,
  shareable starting point before estimating or coding.
---

# Ticket → Structured Brief

## When to use this
Use it the moment a requirement arrives in a form thinner than a real spec: a one-line ticket,
a forwarded email, a "can we also add X" comment. Don't use it on something that's already a
reviewed, complete spec — that's wasted ceremony; use `spec-driven-development` instead to turn
an already-clear ask into an implementation plan.

## Instructions
1. Gather the raw material: ticket text, email/chat export, or verbal notes.
2. Separate: stated goal, stated constraints, unstated assumptions, and anything genuinely unknown.
3. Never invent facts to fill a gap — surface it explicitly as an "Open question" instead of
   guessing at it.
4. Produce the brief in this fixed shape:
   - **Context** — why this is being asked, in one or two sentences.
   - **Goal** — the outcome, stated as a result, not a task list.
   - **Acceptance criteria** — checkable bullet points.
   - **Out of scope** — explicitly named, not left implicit.
   - **Open questions** — anything the source material didn't answer.
   - **Risks / assumptions** — anything being assumed in order to proceed at all.
   - **Suggested next step** — who needs to answer the open questions before work starts.
5. If the input references a design, API, or system you haven't seen, list it under Open
   questions rather than assuming its shape.
6. Keep the brief short enough to read in under two minutes — it's a triage artifact, not a spec.

## Worked example
**Input:** forwarded chat message — "hey can we add a way for users to export their data,
client asked for it on the call yesterday, no ticket yet."

**Output brief (abridged):**
- Context: client verbally requested a data export feature; no ticket exists yet.
- Goal: users can self-serve export their own data.
- Acceptance criteria: *not yet determinable — see open questions.*
- Open questions: which data is in scope? what export format is expected? any regulatory
  constraint (e.g. existing data-export feature already covering this)?
- Risks: may overlap with an existing compliance-driven export feature — verify before building.
- Suggested next step: confirm scope with whoever took the client call before estimating.

## Edge cases / known failure modes
- Input with no goal at all → Goal section states "not stated, ask before proceeding" rather
  than fabricating one.
- Input that already looks like a full spec → still run it; forcing acceptance criteria into
  checkable form has value even for a well-written ticket.
- Multiple conflicting asks in one thread → split into separate briefs rather than merging into
  one artificial combined scope.
- `(extrapolated — not sourced from interviews)`: treating this as a triage step distinct from
  full spec-driven development is an inference from the report's separate, lower-effort framing
  of this item versus the SDD item, not a directly stated distinction.

## Adapting this to your squad
Swap in whatever thin-requirement source you actually get (Jira export, chat thread, email) —
the shape of the output brief stays fixed regardless of source.

---
### Hub catalog metadata
- sdlc_stage: Planning / Requirements
- source_evidence: Vitor Arbex, explicit suggestion — "Skill: ticket → resumo/markdown
  automático," listed as a high-priority quick win (Matriz C: "Alta, quick win, consenso")
- priority: quick-win
- tool_requirements: none (optional: read-only ticketing/chat connector to pull the raw thread
  automatically)
- est_token_footprint: low
- portability_note: pure prompting + a fixed output template, no vendor-specific features;
  runs unchanged in any agent tool
- maintainer: TBD
- status: draft
