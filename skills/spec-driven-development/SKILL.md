---
name: spec-driven-development
description: >
  Guides turning a feature request into a written, reviewed specification before any
  implementation starts, structured as thin vertical slices (a little of every layer, shipping
  something visible fast) rather than horizontal layers (one full layer at a time). Use at the
  start of any feature of meaningful size, especially in microservice/microfrontend
  architectures where horizontal slicing multiplies coordination cost.
---

# Spec-Driven Development (Vertical Slicing)

## When to use this
Use it at the start of any feature-sized piece of work — not for a one-file bug fix. If the
requirement is still too raw to spec, run `ticket-to-brief` or
`requirement-extraction-from-threads` first and feed the result in here. If instead you're
starting a whole new project or initiative from a foundational constitution/PRD/architecture doc
and need a full backlog of specs rather than one, run `constitution-to-specs` first — it
decomposes the constitution into user stories and hands each one to this skill. Once a spec here
passes its review gate, run `spec-to-tasks` to break it into atomic, estimated tasks before
`issue-writer` publishes them.

## Instructions
1. Before writing code, produce a spec covering: the problem being solved, explicit acceptance
   criteria, what's explicitly out of scope, and the slicing plan.
2. Default to **vertical slicing**: define the smallest end-to-end slice (touching every layer
   it needs — data, backend, frontend) that produces something demonstrable, and sequence
   subsequent slices so each adds a complete, visible increment — rather than "finish the whole
   database layer, then the whole API, then the whole UI."
3. Require the spec to be reviewed and agreed (by a human, or against a `ticket-to-brief`
   output) before implementation of the first slice begins — the point is catching ambiguity
   before code, not after.
4. After each slice, check the result against that slice's acceptance criteria before starting
   the next one, rather than discovering misalignment only at the end.
5. If a client or institutional context mandates a specific end-to-end AI-assisted flow (ticket
   → AI builds → human reviews → production), treat this skill as the spec-writing step that
   flow depends on, not a replacement for it — a top-down mandate alone doesn't make the flow
   work in practice; spec quality is what does.

## Worked example
A feature request for "add bulk export" is sliced as: **Slice 1** — export a single, hardcoded
report type end-to-end (data query → API → minimal UI button), proving the full path works.
**Slice 2** — add report-type selection. **Slice 3** — add format options. Each slice is
demoable on its own, instead of building the entire backend export engine before any UI exists
to show it works.

## Edge cases / known failure modes
- A request too small to need slicing (a one-file bug fix) → skip this skill.
- A request where the layers are tightly coupled and can't be usefully separated → note that
  explicitly in the spec rather than forcing an artificial vertical slice that doesn't actually
  reduce risk.
- An institutional mandate to adopt this flow, on its own, is not sufficient — the report
  documents a case where a top-down SDD mandate had not yet produced a working flow in practice
  at the time of observation. Treat rollout as needing active support, not just a directive.

## Adapting this to your squad
Spec template fields can be extended per squad; the vertical-slice-first default and the
"review spec before first slice" gate stay fixed.

---
### Hub catalog metadata
- sdlc_stage: Requirements / Design
- source_evidence: Vitor Arbex (already validated live with a client), reinforced by an
  institutional SDD pilot observed at one client, and by Leonardo's concrete comparison of
  multiple SDD frameworks favoring vertical over horizontal slicing (Matriz C: "Alta, tração
  real já existente em 2 clientes")
- priority: strategic
- tool_requirements: none
- est_token_footprint: medium
- portability_note: pure process/template, no tool dependency
- maintainer: TBD
- status: draft
