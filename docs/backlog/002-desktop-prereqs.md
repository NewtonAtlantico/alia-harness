# Backlog 002: Desktop app prerequisites (core work before the Electron shell)

| | |
|---|---|
| **Status** | In progress. Done: D1 (`createSession`, no globals, explicit workspace/config; `npm run test:session`), D2 (typed event stream; `npm run test:events`). Next: D3 (cancellation). Phase 0 of the desktop app; the app itself will be backlog 003. |
| **Depends on** | `src/core` as it is today (decoupled from `cli/`); subagents S1-S5 (done) |
| **Design** | `alia Harness Desktop.pdf` (chat, changes panel, permission card, pipeline wizard, slash and `@` menus) |
| **Primary consumer** | The standalone Electron app (backlog 003), plus the CLI, which must keep working unchanged |

## 1. Problem

The design needs things `core` cannot do yet. The agent loop works, but it is wired inside
`cli/index.ts`, reports progress through fire-and-forget print calls, cannot be cancelled, forgets
everything on exit, and cannot read the PDF that the pipeline screens use as their first example
input. Building the app on top of that would mean fixing `core` from inside a UI project.

## 2. Goal

Make `core` embeddable: one factory to create an isolated session, a typed event stream a UI can render,
cancellation, richer permissions, persistence, change tracking, document reading, and a structured
pipeline state. After this backlog, the Electron app is a thin front-end, like `cli/`.

### Non-goals

- The Electron app itself: main/preload/renderer, IPC contract, packaging, secret storage (backlog 003).
- An MCP client (backlog 001, section 8). Task D13 only *detects* tracker connections, so it starts
  working by itself the day an MCP client is registered.
- Subagent-per-stage pipeline (001: S6, S8). Decision: v1 runs the pipeline in a single conversation.
- Audio/video transcription. Recordings stay "send a transcript", as the design shows.
- OCR for scanned documents. They are detected and flagged, not read.
- Tracking file changes made through `run_bash` (see D7, known limitation).

## 3. Decisions (made)

| # | Decision |
|---|---|
| 1 | Renderer stack is React + Vite via `electron-vite` (applies to backlog 003). |
| 2 | Pipeline runs in a single conversation for v1; subagents per stage come later. Hence 001's S6 and S8 are **not** prerequisites. Resume after a restart comes from pipeline state on disk (D11, D12). |
| 3 | The Terminal tab is a read-only log of the agent's commands. No `node-pty` in v1. |
| 4 | "Publicar issues" defers to drafts in `docs/issues/` unless a tracker connection is configured. An MCP-backed issue tool **or** an authenticated `gh`/`glab` CLI counts as configured (the `issue-writer` skill already uses the CLI first). If none is, the user gets a warning at every publish attempt, then drafts (D13). |

## 4. Gap-to-task map

| Gap found in the analysis | Task |
|---|---|
| Wiring only in `cli/index.ts` | D1 |
| Process-wide UI and safety globals | D1 |
| `process.cwd()` as workspace and config source | D1 |
| Print calls without ids or pairing | D2 |
| No cancellation | D3 |
| Boolean approvals, no allowlist, dangerous-only gate | D4 |
| No session persistence | D5 |
| Command list lives in the CLI; no `/compact` | D6 |
| No before/after for edits; no undo | D7 |
| PDF, DOCX, PPTX unreadable | D8, D9 |
| Gate questions are free text | D10 |
| `STATE.md` is prose | D11, D12 |
| "Publicar issues" without a tracker | D13 |
| No streaming | D14 (optional) |

## 5. Proposed design

### 5.1 Session factory (D1)

```ts
const session = createSession({
  workspace: 'C:\\Projetos\\portal-cliente',   // explicit; never process.cwd() inside core
  config,                                       // AliaConfig object, or { configPath }
  modelId?: string,
  permissions?: PermissionOptions,              // see 5.4
  onEvent?: (e: AgentEvent) => void,            // see 5.2
  onAskUser?: AskUserHandler,                   // see 5.7
  skillRoots?: SkillRoot[],
});
session.run(prompt)                  // -> AgentResult; D3 adds { signal }
session.prepareInput(text)           // expands @mentions -> { prompt, attachments, errors }
session.resolveSkill('/name', input) // -> not_a_skill | unavailable | ready { prompt, ... }
session.switchModel(idOrName)        // -> { ok, id } | { ok: false, available }
session.listModels()                 // configured + endpoint models
session.reset()
session.getContextUsage()            // { tokens, limit, percent, messages }
session.dispose()
```

As built in D1: `ui`, `onConfirm` and `onAutoApprove` are per-session options and there is no
process-wide default for any of them; `loadConfig({ baseDir, configPath?, loadEnvFile? })` and
`validateConfig(config)` replace the cwd-based lookups; `AgentOptions.workingDirectory` is required;
`SkillRegistry` needs `roots` or `cwd`. A test seam, `client`, lets a fake model replace the OpenAI client.

- It absorbs everything `main()` does today: registry, skills, `use_skill`, `run_subagent`, safety,
  context manager, agent. `cli/index.ts` becomes a consumer of it.
- Each session owns its handlers. The module-level `setDefault*` registrations in `terminal.ts`
  are removed (the CLI passes its handlers in explicitly), so two sessions in one process cannot
  interfere.
- `loadConfig` accepts an explicit path or object and no longer depends on `process.cwd()`. `.env`
  loading becomes opt-in (`loadEnv(dir)`); the API key can be passed in memory, because the desktop
  app will read it from the OS secret store rather than from a file.

### 5.2 Typed event stream (D2)

```ts
type AgentEvent = (
  | { type: 'run_started'; runId: string }
  | { type: 'model_started' | 'model_finished'; step: number }          // the "thinking" spinner
  | { type: 'thinking'; text: string }                                   // reasoning text
  | { type: 'assistant_message'; text: string; final: boolean }
  | { type: 'tool_call_started'; id: string; name: string; args: string }
  | { type: 'tool_call_finished'; id: string; name: string; result: string; isError: boolean; durationMs: number }
  | { type: 'permission_requested'; id: string; toolCallId?: string; command: string; reasons: string[]; requester?: string }
  | { type: 'context_compacted' }
  | { type: 'subagent_started'; id: string; parentToolCallId?: string; label: string; maxSteps: number; skill?: string; quiet: boolean }
  | { type: 'subagent_finished'; id: string; label: string; status: string; steps: number; maxSteps: number }
  | { type: 'notice'; level: 'info' | 'success' | 'error'; message: string }
  | { type: 'run_finished'; runId: string; result: AgentResult }
) & { subagentId?: string };   // set on every event produced inside a subagent
```

As built in D2:

- The `id` of a tool call is the model's `tool_call_id`, so a UI can create a row on `started` and
  update the same row on `finished`. Subagent events carry `subagentId`, and `subagent_started`
  names the parent's `run_subagent` call, so nested work renders under that row.
- `AgentUI` stays as is. `eventsToAgentUI` keeps `TerminalUI` working: the terminal output was
  compared byte for byte, before and after, across 11 scenarios (tools, reasoning, API error, empty
  response, step cap, compact and verbose subagents, fabricated artifact, recursion, compaction).
- `final: false` is the text a model writes alongside tool calls ("Vou ler o loop atual..."), which
  the design shows and the terminal never did. The adapter keeps hiding it, so CLI output is unchanged.
- `permission_requested` is emitted by the session just before it calls `onConfirm`. `toolCallId` is
  filled in by D4.
- `changes?: FileChange[]` on `tool_call_finished` is added by D7.
- Observers are isolated: `combineSinks` catches a throwing sink so it can neither fail the run nor
  starve the others.
- `ToolContext` gained `toolCallId` and `emit`; `SubagentDeps.ui` is gone, because a child now reports
  through the parent's event stream (tagged with its `subagentId`).
- Sessions take `onEvent` (new, primary) and `ui` (legacy, adapted from the same stream).

### 5.3 Cancellation (D3)

- `AliaAgent.runDetailed(prompt, { signal })`. The signal is passed to `client.chat.completions.create`
  (`{ signal }` request option) and checked between tool calls.
- `ToolContext` gains an optional `signal`; `run_bash` kills the child process on abort and returns
  `[Cancelled by user]`; the other tools are short and just check the signal before starting.
- New `AgentStatus` value `cancelled`. A cancelled run leaves history valid: any tool call that was
  announced but not executed gets a synthetic `tool` message, so the next request is not rejected
  for a dangling `tool_call_id`.
- A subagent inherits the parent's signal. This also closes the "Ctrl+C during a child" risk in 001.

### 5.4 Permission model v2 (D4)

```ts
type PermissionDecision = 'allow_once' | 'allow_always' | 'deny';
type PermissionMode = 'ask-dangerous' | 'ask-commands' | 'auto';
```

| Mode | Behavior | Default for |
|---|---|---|
| `ask-dangerous` | Today's behavior: prompt only for `DANGEROUS_PATTERNS` | CLI |
| `ask-commands` | Prompt for every `run_bash` command not on the allowlist | Desktop (the mock prompts on `npm run build`) |
| `auto` | No prompts (current `--auto-approve`) | opt-in |

- `allow_always` stores a command rule (exact command or prefix such as `npm run build`) in
  `<workspace>/.alia/permissions.json`. **Dangerous commands can never be allowlisted**: they always
  prompt, in every mode except `auto`.
- The handler receives `{ command, reasons, requester, toolCallId }` and returns a `PermissionDecision`.
  The old boolean handler keeps working through a shim, so the CLI is untouched at first.
- File writes outside the workspace are out of scope here; `write_file` and `edit_file` behave as today.

### 5.5 Session store (D5)

- Location: `~/.alia/sessions/<workspace-hash>/<sessionId>.jsonl` plus a small `meta.json`
  (`title`, `workspace`, `model`, `createdAt`, `updatedAt`). It lives outside the project on purpose,
  so conversation content is never committed with the repo.
- Content: the OpenAI-format `messages`, appended per message. A UI renders a past conversation from
  them (tool calls and results are already in there); diffs come from the change store (D7).
- API: `create`, `append`, `load`, `list({ workspace? })`, `search(text)` (substring over titles and
  messages, no index in v1), `rename`, `delete`.
- Resume: `createSession({ resume: sessionId })` seeds `agent.messages`. Auto-title from the first
  user message.
- Pinned skill blocks and archived tool outputs are persisted as they are in memory, so a resumed
  session sees exactly what the model saw.

### 5.6 Command registry and `/compact` (D6)

- A `CommandRegistry` in `core` lists built-ins (`/help`, `/model`, `/clear`, `/compact`, `/config`,
  `/tools`, `/skills`, `/tokens`) plus one entry per available skill, with `name`, `description`,
  `kind: 'builtin' | 'skill'`. Both the CLI prompt and the desktop slash menu read from it.
  `/config` is registered by the front-end (core only knows it exists as a UI action).
- `/compact`: summarizes the older history with the model into one pinned message and drops the
  covered turns, keeping the system prompt, pinned skill blocks and the last N messages. Emits
  `context_compacted`. This is more than today's tool-output archiving.
- `session.getContextUsage()` (built in D1, because the CLI's `/tokens` needs it) feeds the context meter.

### 5.7 Change tracking and undo (D7)

```ts
interface FileChange { path: string; before: string | null; after: string | null; runId: string }
```

- `write_file` and `edit_file` call `context.changes?.record(...)` with the content before and after
  writing. `ChangeTracker` keeps a per-session list; the finished tool event carries the change.
- API: `list()`, `diff(path)` (unified diff computed in core; add the small `diff` package),
  `revert(paths?)` (writes `before` back; deletes the file if it was created), `keep()` (clears the
  pending list, so the "Desfazer / Manter alterações" bar goes away).
- `revert` refuses a file whose content on disk no longer equals `after` (the user edited it
  meanwhile) and reports it, instead of clobbering their work.
- **Known limitation:** changes made by commands run with `run_bash` (formatters, `sed`, build output)
  are not tracked. The Changes panel says so; a git-snapshot fallback can come later.

### 5.8 Document readers (D8, D9)

- `readDocument(path, { pages? })` returns text for `.pdf`, `.docx`, `.pptx` using pure-JS libraries
  (no native binaries, so Electron packaging stays simple). Chosen at implementation time with a spike
  comparing `unpdf`/`pdfjs-dist` for PDF and `mammoth` for DOCX; PPTX is read from the zip's slide XML.
- Output keeps provenance the pipeline needs: `[p. 14]` page markers for PDF, `[slide 7]` for PPTX
  including **speaker notes** (the stage 1 skills care about notes-only decks).
- A PDF with no text layer returns a clear message ("scanned document: no text layer, OCR is not
  available") instead of empty text, so the skill carries it into the open questions.
- Audio and video extensions return "recordings cannot be read, send a transcript", matching the
  design's input row.
- `read_file` and `resolveFileMentions` both go through it. `BINARY_EXTENSIONS` keeps rejecting what
  is truly binary. Output still passes `truncateToolOutput`; `read_file` gains a `pages` argument so
  a long BRD can be read in chunks.

### 5.9 `ask_user` and gate questions (D10)

```ts
ask_user({ questions: [{
  id: string,
  kind: 'choice' | 'text' | 'confirm',
  prompt: string,
  options?: [{ id, label, detail?, source? }],   // source: "BRD_v2.pdf · p. 14"
  allowDefer?: boolean,                           // "Adiar: registrar como suposição"
  confidence?: 'low' | 'medium' | 'high',
}] })
// -> JSON: [{ id, answer?, deferred?, owner? }]
```

- Session option `onAskUser` renders the questions (desktop: gate cards; CLI: a simple readline
  prompt). With no handler, the tool returns an `Error:` that tells the model to ask in plain text,
  so every other host keeps today's behavior.
- The tool is withheld from subagents (`without`), since they cannot ask.
- `HARNESS_NOTES` stops saying there is no AskUserQuestion: it maps `AskUserQuestion` to `ask_user`
  when the tool is registered. The pipeline skill already lists `AskUserQuestion`, so it needs no edit.
- A deferred answer must carry an owner. The pipeline records it as an assumption (D11).

### 5.10 Pipeline state (D11, D12)

`STATE.md` is prose that a model writes freely, so a UI cannot rely on it. Make the machine-readable
file the source of truth and render the prose from it:

- `docs/pipeline/state.json` holds inputs (with kind and handling skill), stages (status, artifact,
  gate), gate questions (`open | answered | deferred`, answer, by, date, source), decisions,
  assumptions (with owner and stage), ADRs, and a free `notes` list.
- A `pipeline_state` tool (`get`, `update` with a patch) reads and writes it, validates the schema,
  and **regenerates `STATE.md`** deterministically after each update. Skills keep working without
  the tool: the pipeline skill gets one added line, "use `pipeline_state` when available, otherwise
  write `STATE.md` by hand".
- Derived numbers (specs, tasks, points, per-spec totals, dependencies) are parsed from
  `docs/tasks/*-tasks.md` by a function in core, tested against the `spec-to-tasks` output format with
  a golden file, instead of asking the model to count.
- Resume (D12): `getPipelineStatus(workspace)` returns the first incomplete stage or open gate, and
  flags a changed input (hash mismatch vs the manifest) as `stale`, as the skill already requires.
  `createSession` can seed a "resume the pipeline" prompt from it.

### 5.11 Tracker detection (D13)

```ts
detectIssuePublishing(session): {
  mcp: string[];                    // registered tool names that can create issues (e.g. createJiraIssue)
  cli: { gh?: 'ready' | 'unauthenticated' | 'missing'; glab?: ... };
  mode: 'publish' | 'drafts';
  warning?: string;
}
```

- `mode` is `publish` when an MCP-backed issue tool is registered (same prefix rule as `requires:`)
  **or** a `gh`/`glab` CLI is installed and authenticated for the repo's remote. Otherwise it is `drafts` and `warning` says that no tracker connection was found and that drafts
  will be saved to `docs/issues/`. The app shows this before the user confirms "Publicar issues".
- The `issue-writer` skill already falls back to `docs/issues/<date>-<slug>.md`; no skill change.
- Today the harness has no MCP client, so v1 resolves to `publish` only through an authenticated CLI.

## 6. Tasks

Points are Fibonacci, capped at 8, matching `spec-to-tasks`.

| ID | Task | Pts | Acceptance criteria |
|---|---|---|---|
| D1 | **Done.** `createSession()` factory; remove global handlers; explicit workspace and config | 5 | `cli/index.ts` is a thin consumer of `createSession`. Importing `terminal.ts` has no side effects. Two sessions with different workspaces and handlers run in one process without interference (fake-model test). `loadConfig` takes a path or object; no `process.cwd()` reads remain in `core`. `npm run test:*` and `typecheck` pass. |
| D2 | **Done.** Typed `AgentEvent` stream + `eventsToAgentUI` adapter | 5 | Every `AgentUI` call has an event equivalent with stable tool-call ids and `durationMs`. CLI output is identical to before. A test records the event sequence for a run with two tool calls and a subagent. |
| D3 | Cancellation via `AbortSignal` (loop, API call, `run_bash`, subagents) | 3 | Aborting mid-API-call and mid-`run_bash` ends the run with `cancelled` within a second, kills the child process, and leaves history valid (no dangling `tool_call_id`). A following `run()` works. |
| D4 | Permission model v2: decisions, modes, per-project allowlist | 5 | `allow_always` persists and applies on the next session; dangerous commands still prompt in `ask-dangerous` and `ask-commands`; `auto` skips prompts; legacy boolean handler still works; the permission event carries the tool-call id. |
| D5 | Session store (JSONL), resume, list, search, rename | 5 | A run is persisted and `resume` reproduces the same `messages`. `list` filters by workspace; `search` finds text in titles and messages. A corrupted last line is skipped, not fatal. Nothing is written inside the workspace. |
| D6 | `CommandRegistry`, `/compact`, `getContextUsage()` | 3 | CLI prompt and a test consumer read the same command list (built-ins plus skills). `/compact` shrinks a long history, keeps system prompt, pinned skills and recent turns, and the run continues correctly afterwards. |
| D7 | `ChangeTracker`: record, diff, revert, keep | 5 | `edit_file` and `write_file` record before/after; `diff` returns a unified diff; `revert` restores or deletes; revert skips a file modified after the agent's change and reports it; `keep` clears the list. |
| D8 | `readDocument` for PDF with page markers; integrate into `read_file` and `@` mentions | 5 | A sample multi-page PDF reads with `[p. N]` markers; `pages` argument works; a scanned PDF returns the no-text-layer message; audio/video return the transcript message; `@file.pdf` attaches text. |
| D9 | `readDocument` for DOCX and PPTX (slides and speaker notes) | 3 | Sample DOCX keeps headings and tables as readable text; PPTX output has `[slide N]` markers and includes notes; both work through `read_file` and `@`. |
| D10 | `ask_user` tool, `onAskUser` handler, HARNESS_NOTES mapping | 5 | With a handler, questions round-trip as structured answers (including a deferral with owner); without one the tool errors with the plain-text fallback instruction; it is absent in subagents; the CLI implements a basic handler. |
| D11 | `pipeline_state` tool, `state.json` schema, `STATE.md` rendering, derived task stats | 5 | Updates validate against the schema and re-render `STATE.md`; stats (tasks, points, per spec) match a golden `spec-to-tasks` sample; the pipeline skill carries the one-line instruction and still works without the tool. |
| D12 | Pipeline status and resume, with stale-input detection | 3 | Given a state file stopped at Gate 1 (3 of 5 answered), `getPipelineStatus` reports that, and a resumed session continues from the open questions. A modified input file is flagged `stale`. |
| D13 | `detectIssuePublishing()` with the warning | 3 | Registry with an MCP issue tool resolves to `publish`; a ready `gh`/`glab` CLI resolves to `publish`; neither resolves to `drafts` with the warning text; verified with a fake registry and a stubbed CLI probe. |
| D14 | *(optional)* Streaming of assistant text and reasoning | 5 | `assistant_delta` and `thinking_delta` events during a run, final message unchanged; falls back to non-streaming when the endpoint does not support it. Can ship after the app's v1. |

Total: 55 points (60 with D14).

### Order and phase gates

```
D1 -> D2 -> D3 -> D4          Foundation. Backlog 003 (shell + chat) can start once D1-D4 are done.
D5, D6                        Needed for the sidebar and slash menu; run in parallel with the shell.
D7                            Gate for the Changes panel.
D8 -> D9, D10 -> D11 -> D12   Gate for the pipeline wizard.
D13                           Gate for the final screen's "Publicar issues".
```

Within the foundation, D2 before D3 because cancellation adds an event and a status.

## 7. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Removing the globals breaks the CLI or the smoke tests. | D1 lands first with the CLI migrated in the same change; the fake-model suites are the safety net. |
| Rewriting `AgentUI` into events changes CLI output subtly. | Adapter plus identical-output tests (D2); `AgentUI` stays public. |
| A small model ignores `pipeline_state` and hand-writes `STATE.md`. | The tool is the source of truth only when used. The status function detects drift (`STATE.md` newer than `state.json`) and the wizard shows a warning; fall back to code-driven orchestration if it recurs (001, option B). |
| Single-conversation pipeline hits the 128k window on large BRDs. | `read_file` `pages` chunking (D8), `/compact` (D6), and the wizard shows the context meter. Subagent-per-stage remains the planned escape hatch. |
| PDF or DOCX parsers misread complex layouts. | Spike before choosing (D8); keep page markers so the model can cite and the human can verify; scanned and low-text files are flagged, not guessed. |
| `allow_always` becomes a hole. | Dangerous patterns are never allowlistable; the allowlist is per project, human-readable JSON, and shown in the settings screen (backlog 003). |
| Revert overwrites user edits. | D7 compares disk content with `after` first and skips conflicts. |
| Session files hold sensitive document content. | Stored under `~/.alia`, outside the repo; delete is a first-class operation (D5). |

## 8. Open items

None at the moment. Resolved: a ready `gh`/`glab` CLI counts as a tracker connection, and the
"no tracker connection" warning is shown at every publish attempt while the mode is `drafts`.

## 9. Definition of done

- `npm run typecheck`, `test:skills`, `test:agent`, `test:subagents` pass, plus new smoke tests for
  D1 to D13 using the fake-model harness (no network or API key).
- The CLI behaves as before (same prompts, same output) after being migrated to `createSession`.
- A scripted run proves, without any UI: a session is created, streams typed events, is cancelled
  mid-command, persists and resumes, records and reverts a file change, reads a PDF, asks a gate
  question and records the answer in `state.json` with a rendered `STATE.md`.
- Backlog 003 (Electron app) is written against these APIs, not against `cli/`.
