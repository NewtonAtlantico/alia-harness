---
name: spec-to-tasks
description: Decomposes a reviewed spec into atomic, independently implementable tasks, each sized with Fibonacci story points (1, 2, 3, 5, 8) capped at 8 — splitting anything larger — with a clear description and verifiable acceptance criteria per task. Use after a spec-driven-development spec (or a constitution-to-specs backlog) is reviewed and before implementation or issue creation begins.
---

# Spec to Tasks

Turns a reviewed spec into a backlog of atomic tasks small enough to estimate with confidence,
implement in one sitting, and verify independently. This skill sits between spec writing and
issue creation: `spec-driven-development` (or `constitution-to-specs` for a whole backlog)
produces the spec, this skill breaks it into tasks, and `issue-writer` turns each task into a
publishable issue.

## When to invoke

- A `spec-driven-development` spec exists and has passed its review gate, but no task breakdown
  exists yet
- A `constitution-to-specs` backlog produced multiple specs and each now needs its own task list
- A spec's vertical slices are defined but still too coarse to hand to an implementer or estimate
  with confidence
- **Not** for a spec that is still unreviewed or ambiguous — route it back through
  `spec-driven-development` (or `ticket-to-brief` if it isn't even spec-shaped yet) first;
  decomposing an unstable spec just produces unstable tasks
- **Not** for publishing the tasks as issues — that's `issue-writer`, once this skill's output
  exists

## Inputs

- A reviewed spec: problem statement, acceptance criteria, out-of-scope, and (if produced by
  `spec-driven-development`) its vertical-slicing plan
- If the spec has no explicit slicing plan, treat the whole spec as slice 1 and apply step 1
  below to establish slices before decomposing into tasks

## Process

1. **Confirm the spec is decomposition-ready.** It must have a stated problem, explicit
   acceptance criteria, and explicit out-of-scope. If any is missing or vague, stop and flag the
   gap back to the spec instead of inventing detail to fill it — a task built on a guessed
   acceptance criterion is a wasted task.

2. **Walk the spec's vertical slices in order.** Each slice becomes one or more tasks; do not
   flatten slices back into horizontal layers when breaking them into tasks — a slice's tasks
   should still each contribute to that slice's demoable outcome.

3. **Split each slice into atomic tasks.** A task is atomic when all of the following hold:
   - It can be implemented by one person without switching domain context mid-task
   - It can be verified on its own, against its own acceptance criteria, without waiting on a
     sibling task to also finish
   - It maps to exactly one Fibonacci point value at or below 8 (see table below)
   - Its description names a single, coherent outcome — not "and" joining two unrelated changes

4. **Estimate every task with Fibonacci story points, starting at 1** — 1, 2, 3, 5, 8. Never
   assign a value outside this sequence (no 4, no 13). If a task's true complexity would land
   above 8, it is not atomic yet — split it into two or more smaller tasks and re-estimate each
   one, rather than recording a value the sequence doesn't offer.

   | Points | Typical shape | Signal |
   |---|---|---|
   | 1 | Trivial, single-file change | Config value, copy change, one-line fix — no real unknowns |
   | 2 | Small, well-understood change | 1–2 files, existing pattern to follow, minimal new logic |
   | 3 | Small feature slice or moderate logic | A few files, one clear new behavior, light test surface |
   | 5 | Meaningful unit of work within one concern | Multiple files or one non-trivial algorithm/integration, real but boundable unknowns |
   | 8 | Largest task this skill allows standing alone | Cross-file, possibly cross-layer, still one coherent outcome — treat as a signal to double-check it can't split further |

5. **Write each task using the template below.** The description and acceptance criteria come
   from the spec's own language wherever possible — restate, don't reinterpret, the spec's intent
   into task-sized scope.

6. **Note dependencies between tasks explicitly**, both within a slice and across slices (e.g. a
   task in slice 2 needing a data model a slice 1 task creates). Don't mark a task independent
   just because INVEST prefers it — an unacknowledged dependency causes more damage than a stated
   one.

7. **Validate the full task list against the spec** before handing it off:
   - Every acceptance criterion in the spec is covered by at least one task's acceptance criteria
   - No task exceeds 8 points
   - No task bundles more than one coherent outcome
   - Every stated dependency between tasks reflects a real ordering constraint, not a guess

8. **Hand off.** The validated task list is the input to `issue-writer` for publishing each task
   as an issue, one at a time — this skill's job ends at "a reviewable, atomic, estimated task
   list exists."

## Task template

```markdown
### <task title>

**Slice:** <which vertical slice this belongs to>
**Story points:** <1 | 2 | 3 | 5 | 8>
**Depends on:** <other task titles, or "none">

**Description**
<What this task accomplishes and why, in the spec's own terms — one coherent outcome only.>

**Acceptance criteria**
- [ ] <verifiable criterion 1>
- [ ] <verifiable criterion 2>

**Out of scope**
<Anything adjacent this task deliberately excludes, if not already covered by the spec's own
out-of-scope section.>
```

## Worked example

Spec: "add bulk export," already vertically sliced by `spec-driven-development` into
**Slice 1** (export a single hardcoded report type end-to-end) and **Slice 2** (add report-type
selection).

Slice 1 decomposes into:
- **Task 1.1** — "Add export query for the hardcoded report type" (3 pts): backend query only,
  verifiable by unit test against known data, no dependencies.
- **Task 1.2** — "Expose export query via API endpoint" (2 pts): depends on 1.1, thin
  controller/route wiring following an existing pattern.
- **Task 1.3** — "Add export button to UI, wired to the endpoint" (3 pts): depends on 1.2,
  verifiable by clicking the button and confirming a file downloads.

None of these exceed 8 points individually, each has one verifiable outcome, and together they
reproduce the slice's full acceptance criteria — so none needed further splitting.

## Edge cases / known failure modes

- A single spec requirement is genuinely too large even after slicing (e.g. "migrate the auth
  system") → split the slice itself further via `spec-driven-development` before applying this
  skill, rather than forcing a same-day task out of a multi-week effort.
- A task keeps landing at "maybe 8, maybe more" → treat that uncertainty itself as a signal to
  split; an 8 you're not confident in is usually two smaller tasks wearing a trenchcoat.
- Acceptance criteria in the spec are already granular enough to be tasks 1:1 → still write the
  full task template per one (points, dependencies) rather than skipping estimation because the
  scope looks obvious.
- A task's only reasonable estimate is 1 point but it has no independent verification path (e.g.
  "update a shared constant") → fold it into the smallest task that depends on it instead of
  leaving an unverifiable task standing alone.

## Adapting this to your squad

The Fibonacci scale, the task template's fields, and where the backlog lives on disk can all be
adapted per squad. What stays fixed: story points start at 1 and follow Fibonacci with no value
above 8 standing alone, and every task carries both a description and checkable acceptance
criteria — an estimate without acceptance criteria isn't a task, it's a guess with a number
attached.

## Implementation checklist

- [ ] Every task maps to exactly one Fibonacci value (1, 2, 3, 5, 8) — no off-sequence numbers
- [ ] No task exceeds 8 points; anything that would was split and re-estimated
- [ ] Every task has a description stating one coherent outcome and a checkable acceptance
      criteria list
- [ ] Every task traces to the slice and spec requirement it came from
- [ ] Dependencies between tasks are stated explicitly, not left implicit
- [ ] Every spec acceptance criterion is covered by at least one task

## Common mistakes

- Estimating in points outside the Fibonacci sequence (4, 6, 10) instead of splitting or
  re-scoping to land on a valid value
- Recording an 8-point task that's actually bundling two unrelated outcomes rather than admitting
  it needs to split
- Writing acceptance criteria that restate the task title instead of giving a checkable
  condition
- Flattening vertical slices back into horizontal layers ("all backend tasks," "all frontend
  tasks") when breaking a slice into tasks
- Treating every task as independent by default instead of stating real ordering constraints
