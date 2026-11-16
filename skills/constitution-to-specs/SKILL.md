---
name: constitution-to-specs
description: >
  Reads a new software project's architectural/requirements "constitution" (principles,
  non-negotiable constraints, personas, high-level scope, tech stack) and decomposes it into a
  backlog of independent user stories, producing one spec-driven-development spec per story. Use
  at the start of a new project or major initiative when a foundational constitution/PRD/
  architecture doc exists but no specs yet — before any individual feature spec is written.
---

# Constitution to Specs

## When to use this
Use it once, at the start of a new project or major initiative, when a "constitution" exists —
a foundational document stating the project's architectural principles, non-negotiable
constraints (security, compliance, tech stack), target personas, and high-level scope — but no
per-feature specs exist yet. This skill is the bridge between that constitution and
`spec-driven-development`: it decomposes the constitution into user stories and produces one
spec per story, then hands each spec to `spec-driven-development`'s vertical-slicing discipline
for actual implementation planning.

Don't use it on a single, already-scoped feature request — that's `spec-driven-development`
directly. If the constitution itself is still raw (a slide deck, a messy BRD, a thread of
decisions) rather than a clean written document, run `requirement-extraction-from-documents` or
`requirement-extraction-from-threads` first and feed the result in here.

## Instructions
1. **Ingest and validate the constitution.** Confirm it actually covers: architectural principles,
   non-negotiable constraints (security, compliance, tech stack mandates), target
   personas/actors, and high-level scope. If a piece is missing, flag the gap explicitly rather
   than inventing it — an assumed constraint silently baked into every downstream spec is much
   more expensive to unwind later than a flagged gap now.
2. **Extract the non-negotiables separately from the features.** Architectural principles, tech
   stack mandates, and compliance requirements bind every story regardless of which one it is.
   Pull them into a standalone constraints list once, and reference it from every spec instead of
   re-deriving or re-copying it per spec.
3. **Identify personas/actors** named or implied by the constitution. Every user story should
   trace to one of them; a capability with no clear actor is usually a sign the constitution is
   describing a system property (e.g. "the system shall log all writes"), not a user story —
   route those into the constraints list instead of forcing a story out of them.
4. **Decompose scope into candidate user stories.** For each persona, identify the independently
   valuable, independently testable capabilities the constitution implies. Apply INVEST
   (Independent, Negotiable, Valuable, Estimable, Small, Testable) as the filter: split a
   capability that bundles multiple unrelated outcomes, and merge fragments too small to be
   individually demoable.
5. **Sequence stories before writing specs.** Order stories so the earliest ones establish a
   walking skeleton (the thinnest end-to-end path through the architecture) that later stories
   build on — the same "smallest demoable slice first" logic `spec-driven-development` applies
   within a single feature, but one level up, across the whole backlog. Note real dependencies
   between stories explicitly rather than pretending every story is independent when it isn't.
6. **For projects spanning multiple bounded contexts**, group stories by context before writing
   specs (pull in `ddd-bounded-context` if boundaries aren't already explicit in the
   constitution) — a flat pile of stories from unrelated contexts makes sequencing and ownership
   unclear.
7. **Write one spec per story**, using `spec-driven-development`'s structure (problem, acceptance
   criteria, out-of-scope, vertical-slicing plan) and format — this skill does not invent a
   competing spec template. Each spec must:
   - Reference the persona it serves and the relevant constraints from step 2 by name, not by
     re-stating them.
   - Note which other story specs it depends on, per the sequencing in step 5.
8. **Maintain a backlog index** mapping story → spec file → status (draft / reviewed / in
   progress / done), so every spec stays traceable back to the constitution section it came from
   and to the other specs it depends on.
9. **Route each spec through `spec-driven-development`'s review gate** before its first slice is
   implemented. This skill's job ends at "a reviewable backlog of specs exists" —
   `spec-driven-development` still governs the discipline of implementing each one.
10. **If the constitution changes after specs already exist**, flag which specs are affected by
    the change (via the constraints/persona references captured in step 7) rather than silently
    regenerating the whole backlog.

## Suggested output layout
```
docs/specs/
├── INDEX.md                  # backlog: story -> spec file -> status -> depends-on
├── constraints.md            # non-negotiables extracted once, referenced by every spec
├── <story-slug>-spec.md      # one per story, spec-driven-development format
└── ...
```

## Worked example
A constitution for a new internal expense-reporting system states: React/TypeScript frontend,
Postgres-backed API, SOC2-relevant audit logging is mandatory on every write, and three personas
(employee, approver, finance admin). Decomposition produces:
- **Constraints list**: audit logging on all writes, tech stack mandate, SSO-only auth.
- **Stories** (sequenced): (1) employee submits an expense report — the walking skeleton, proving
  the full stack end-to-end; (2) approver approves/rejects a report; (3) finance admin exports
  approved reports to the accounting system. Story 3 is flagged as depending on story 2's
  "approved" state existing.
- Three spec files are written, each referencing `constraints.md` rather than repeating the audit
  logging requirement inline, and each ready to be sliced vertically per `spec-driven-development`.

## Edge cases / known failure modes
- Constitution too vague to yield concrete acceptance criteria → don't fabricate detail; flag the
  ambiguity and route the gap back through `ticket-to-brief` or a stakeholder conversation before
  specs are written on top of a guess.
- Constitution describes what is really a single feature, not a multi-story project → don't force
  an artificial decomposition; hand it directly to `spec-driven-development`.
- Constraints conflict with each other within the constitution (e.g. a stated tech mandate
  contradicts a stated compliance requirement) → flag the conflict explicitly rather than
  silently resolving it in one story's spec.
- A story is not actually independent of others (shared state, ordering constraint) → note the
  dependency in both specs' "depends-on" field rather than pretending INVEST's "Independent" was
  satisfied.
- Constitution is a raw/unstructured source (deck, thread, legacy doc) rather than a clean
  document → run `requirement-extraction-from-documents` or `requirement-extraction-from-threads`
  first; this skill assumes the constitution itself is already a coherent document.

## Adapting this to your squad
Story granularity, the backlog index format, and where specs live on disk can all be adapted per
squad; what stays fixed is: constraints extracted once and referenced (not duplicated) per spec,
stories sequenced before specs are written, and every resulting spec still passing through
`spec-driven-development`'s review gate before implementation starts.

---
### Hub catalog metadata
- sdlc_stage: Planning
- source_evidence: `(gap-fill — not sourced from the original opportunity report)`: added to
  bridge a project-level constitution document and `spec-driven-development`, which starts from
  an already-scoped single feature; nothing in the existing catalog covered backlog-level
  decomposition into per-story specs
- priority: TBD
- tool_requirements: none
- est_token_footprint: medium-high (constitution documents and multi-story backlogs run long;
  process persona-by-persona or context-by-context for large ones)
- portability_note: pure process/template, builds directly on `spec-driven-development`'s format;
  no vendor-specific tooling
- maintainer: TBD
- status: draft
