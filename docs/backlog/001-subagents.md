# Backlog 001: Subagents (phase 2 of skills)

| | |
|---|---|
| **Status** | Not started (planned after skills phase 1) |
| **Depends on** | Skills phase 1: `use_skill`, skill catalog, pinned skill output, `requires:` gating |
| **Primary consumer** | `requirements-to-tasks-pipeline` (`skills/e2e-pipeline`) |

## 1. Problem

`requirements-to-tasks-pipeline` runs four heavy stages (requirements, architecture, specs, tasks) and
calls other skills at each one. In the harness today it runs as **one conversation**, which has three
costs on `gpt-oss:20b` (128k input window, `maxSteps = 30`):

1. **Context pressure.** Every stage adds source documents, skill bodies (pinned, so never pruned) and
   tool output to the same history. `ContextManager.pruneMessages` only archives old tool output; it
   cannot drop a stage that is finished.
2. **Step budget.** One `AliaAgent.run()` call has a single 30-step cap. A multi-stage run hits
   "maximum allowable steps" before it concludes.
3. **Reliability.** A small model follows a gated, multi-stage process better when each stage starts
   from a clean, focused context than when it carries every prior stage's detail.

## 2. Goal

Let the model (or a `/command`) run a task in a **fresh, isolated agent** that has its own message
history, step budget and (optionally) pre-loaded skill. The subagent does the work, writes results to
files, and returns only a short, structured result to the caller.

### Non-goals (this backlog item)

- Parallel subagents (see section 8, "Later").
- MCP client / Jira integration (separate item; it also gates `add-tasks-to-jira`).
- Streaming subagent output to the UI token by token.
- Cross-session persistence beyond the files the pipeline already writes (`docs/pipeline/STATE.md`).

## 3. Proposed design

### 3.1 The tool

```ts
run_subagent({
  task: string,            // what to do; becomes the subagent's first user message
  skill?: string,          // optional skill name, pre-loaded (pinned) so use_skill isn't needed
  inputs?: string[],       // file paths attached like @mentions (reuses resolveFileMentions)
  max_steps?: number,      // default 40, hard cap 80
})
// returns (text, capped at ~4k chars):
//   STATUS: completed | blocked | failed | max_steps
//   SUMMARY: ...
//   ARTIFACTS: path, path, ...
//   QUESTIONS: ... (only when blocked)
```

Created as a factory, like `createUseSkillTool(registry)`, so it closes over the pieces it needs to
build a child agent (client, model, config, safety checker, skill registry). `ToolContext` stays as is.

### 3.2 Isolation rules

| Aspect | Rule |
|---|---|
| Messages | New `AliaAgent`; empty history. The parent only receives the final result text. |
| System prompt | Base prompt + skill catalog + a short "you are a subagent" block (no user to ask, write artifacts to files, end with the STATUS block). |
| Tools | Parent's tools **minus `run_subagent`** (depth 1 only; no recursion). A `maxDepth` option leaves room to relax this later. |
| Model | Inherits the parent's current model (`/model` switches apply). |
| Safety | Shares the parent's `SafetyChecker`, including `--auto-approve`. Runs sequentially in this phase, so approval prompts never interleave. |
| Skill | If `skill` is given, its body is placed in the first user message through `buildSkillInvocationPrompt`, which the context manager already protects from pruning. |
| Working dir | Same as the parent. Files are the hand-off channel, not the chat. |

### 3.3 Human gates

A subagent cannot ask the user. The pipeline skill already defines the non-interactive protocol:
**stop at the gate, write the open questions into the artifact, set `STATE.md` to `blocked`, return the
questions.** The subagent contract turns that into `STATUS: blocked` + `QUESTIONS:`. The parent then asks
the user in plain text, records the answers, and starts a **new** subagent for the same stage; it resumes
from `STATE.md` instead of from remembered context.

### 3.4 Where the orchestration lives (decision needed, see 6)

- **A. Model-driven (recommended first).** The existing pipeline skill is the parent; it calls
  `run_subagent` once per stage. Least new code, and it reuses the skill as written.
- **B. Code-driven.** A `/pipeline` command in TypeScript reads `STATE.md`, runs each stage as a
  subagent and handles gates itself. More reliable on a small model, but duplicates the skill's logic
  in code.

Build A first. Move to B only if the parent model proves unreliable at sequencing (see 7).

## 4. Required changes to existing code

| Area | Today | Change |
|---|---|---|
| `src/agent/agentLoop.ts` | `run()` returns a bare string; failures and "max steps" are also plain strings. | Add `runDetailed(): Promise<AgentResult>` with `{ status, text, steps }`; keep `run()` as a thin wrapper so the REPL is unchanged. |
| `src/ui/terminal.ts` | Static methods print straight to stdout. | Add an output context (indent + dimmed prefix, `quiet` mode) so a child's thinking/tool lines are visibly nested, or collapsed to a one-line-per-step trace. |
| `src/tools/index.ts` | One `ToolRegistry` built in the constructor. | Add `ToolRegistry.without(names)` / `clone()` to build the child's tool set. |
| `src/index.ts` | Wires skills and tools once. | Register `run_subagent` after `use_skill`; pass `/tokens` a per-run subagent usage summary. |
| `ContextManager` | Estimates tokens for one history. | No change needed. Child and parent each own one. |

## 5. Tasks

Points are Fibonacci, capped at 8, matching the `spec-to-tasks` convention used in this hub.

| ID | Task | Pts | Acceptance criteria |
|---|---|---|---|
| S1 | `AgentResult` + `runDetailed()` | 3 | Returns `completed`, `max_steps`, `failed` (API error / empty response) with step count. `run()` output unchanged; existing REPL behavior unaffected. |
| S2 | Terminal output context (nesting/quiet) | 3 | A child run prints indented, labelled lines; `quiet` prints one summary line per tool call. Parent output is byte-identical when no subagent runs. |
| S3 | `ToolRegistry.without()` and depth guard | 2 | Child registry lacks `run_subagent`; a child that somehow calls it gets a clear error. |
| S4 | `run_subagent` tool + child system prompt | 5 | Spawns an isolated agent, returns the structured result capped at 4k chars; honors `max_steps` and the hard cap; child history never leaks into the parent's `messages`. |
| S5 | Skill pre-load and `inputs` attachments | 3 | `skill` arg injects the pinned skill body; `inputs` attach through `resolveFileMentions`; unknown/unavailable skill returns an `Error:` string like `use_skill`. |
| S6 | Blocked-at-gate protocol | 3 | A child that ends with `STATUS: blocked` returns `QUESTIONS`; parent asks the user, then re-spawns; second run resumes from `STATE.md`. Verified with a scripted fake model. |
| S7 | Fake-model test harness + smoke test (`npm run test:subagents`) | 5 | Scripted `OpenAI`-compatible client drives the loop deterministically. Covers: isolation, depth guard, step cap, blocked path, error path. No network or API key needed. |
| S8 | Update `requirements-to-tasks-pipeline` for the harness | 3 | Skill (or a harness-specific note in its README) says to use `run_subagent` per stage when available and falls back to inline stages when it is not. Add `requires: run_subagent` only to a harness-specific variant, so Claude Code still works. |
| S9 | Docs + `/help` + README | 2 | `run_subagent` documented; `/tools` lists it; limits and gate protocol explained. |

Suggested order: S1, S3, S2, S4, S7, S5, S6, S8, S9. Total: 29 points.

## 6. Decisions needed before starting

1. **Orchestration: A (model-driven) or B (code-driven)?** Default to A, with B as the escape hatch.
2. **Result format:** the `STATUS/SUMMARY/ARTIFACTS/QUESTIONS` text block above, or JSON? Text suits a
   small model better; JSON is easier to test. (Leaning text, parsed leniently.)
3. **Default and cap for `max_steps`** (proposed 40 / 80). The parent loop is 30 today. Should that
   rise too?
4. **Should skills be able to opt into forking** with a frontmatter key (for example `context: fork`),
   so `/spec-to-tasks` always runs isolated? Useful but couples skills to harness behavior; defer
   unless the pipeline needs it.
5. **UI:** full nested transcript or one line per child step by default?

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The parent (a 20B model) skips stages or ignores `blocked`. | Keep the result block rigid; test with the fake model; fall back to option B (code-driven) if it fails in practice. |
| Child fabricates completion without writing artifacts. | Result must list `ARTIFACTS`; the parent verifies each path exists (with `list_files`) before moving on. Consider having the tool itself check the listed paths. |
| Runaway cost or loops. | Hard `max_steps` cap, depth 1, and a per-run subagent budget shown in the UI. |
| Approval prompts from a child confuse the user. | Label prompts with the subagent's task; run sequentially. |
| Ctrl+C during a child. | Propagate cancellation to the child loop; parent receives `failed: cancelled`. |
| A resumed stage trusts stale `STATE.md`. | The pipeline skill already marks `stale`; the child prompt tells it to re-read the inputs' versions before continuing. |

## 8. Later (explicitly out of scope now)

- **Parallel subagents** (for example one `spec-to-tasks` per spec). Needs serialized approval prompts,
  per-agent output buffering, and care with concurrent writes to `STATE.md`.
- **Role-specific subagents** (reviewer, explorer) with tool subsets declared in config.
- **MCP client**, so `add-tasks-to-jira` and `playwright-mcp-verification` become available (they are
  currently hidden by their `requires:` field).
- **Model routing:** a cheaper or faster model for exploration subagents.

## 9. Definition of done

- `npm run typecheck`, `npm run test:skills`, `npm run test:subagents` pass.
- Running the pipeline on a sample BRD completes stages 1 to 4 across separate subagents, with the
  parent's history containing only the short result blocks.
- A deliberately ambiguous input produces `blocked`, a question to the user, and a correct resume.
- Parent token estimate after a full run is materially lower than the single-conversation run
  (record both numbers in the PR).
