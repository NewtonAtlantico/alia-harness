# Backlog 002: Desktop app prerequisites (core work before the Electron shell)

| | |
|---|---|
| **Status** | In progress. Done: D1 (`createSession`, no globals, explicit workspace/config; `npm run test:session`), D2 (typed event stream; `npm run test:events`), D3 (cancellation; `npm run test:cancel`), D4 (permission model v2; `npm run test:permissions`), D5 (session store; `npm run test:store`), D6 (command registry, `/compact`; `npm run test:commands`), D7 (change tracking and undo; `npm run test:changes`), D8 (PDF reading; `npm run test:documents`), D9 (DOCX and PPTX; `npm run test:office`), D10 (`ask_user`; `npm run test:askuser`), D11 (pipeline state; `npm run test:pipeline`), D12 (pipeline status and resume; `npm run test:resume`). Next: D13 (tracker detection). Phase 0 of the desktop app; the app itself will be backlog 003. |
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
  | { type: 'tool_call_finished'; id: string; name: string; result: string; isError: boolean; durationMs: number; changes?: FileChangeSummary[] }
  | { type: 'permission_requested'; id: string; toolCallId?: string; command: string; reasons: string[]; dangerous: boolean; canAlwaysAllow: boolean; requester?: string }
  | { type: 'permission_resolved'; id: string; toolCallId?: string; decision: 'allow_once' | 'allow_always' | 'deny' | 'cancelled' }
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
- `permission_requested` is emitted by the session just before it calls `onConfirm`, and
  `permission_resolved` when it is answered or the run is cancelled with the card open (D4).
- `tool_call_finished.changes` (D7) lists the files that call wrote as `{ path, kind, added, removed }`, with no file content, so it stays small across IPC; fetch the diff from `session.changes`.
- Observers are isolated: `combineSinks` catches a throwing sink so it can neither fail the run nor
  starve the others.
- `ToolContext` gained `toolCallId` and `emit`; `SubagentDeps.ui` is gone, because a child now reports
  through the parent's event stream (tagged with its `subagentId`).
- Sessions take `onEvent` (new, primary) and `ui` (legacy, adapted from the same stream).

### 5.3 Cancellation (D3)

- `session.run(prompt, { signal })` and `AliaAgent.runDetailed(prompt, { signal })`. The signal is
  handed to `client.chat.completions.create` **and** raced in the loop (`raceAbort`), so a client that
  ignores it cannot keep a cancelled run waiting. A response that arrives just as the user cancels
  is dropped, not acted on.
- `ToolContext.signal`. `ToolRegistry.execute` refuses new work once it is aborted (returns a
  `[Cancelled by user] ...` result), so tools that never look at the signal are still safe. `run_bash`
  kills the command and answers immediately, without waiting for its pipes to drain.
- New `AgentStatus` value `cancelled` (text "Run cancelled by user."). `tool_call_finished` marks an
  interrupted call `isError: true`.
- A cancelled run leaves the history valid: every tool call the model announced but the loop did
  not execute gets a synthetic tool message, so the next request is not rejected for a dangling
  `tool_call_id`. The same agent or session can run again.
- A subagent inherits the parent's signal; its `subagent_finished` event has status `cancelled`.
- The approval is part of the run: `confirmIfDangerous(command, signal)` races the user's handler
  against the signal, and `SafetyConfirmationContext.signal` lets a UI dismiss its approval card.
  The CLI prompt does (`rl.question(..., { signal })`).

Known limitations:

- **Process trees:** on Windows, `taskkill /T /F` ends the command and everything it started (verified
  with a grandchild process). On macOS/Linux the shell gets `SIGTERM`, which is enough for a simple
  command but may leave descendants of a compound command running. It was not exercised on those
  platforms here.
- **Timeouts** (`timeout_ms`) still use Node's own timeout, which stops the shell only. Making them
  use the same tree kill is a small follow-up.
- **CLI Ctrl+C:** unchanged (it still exits the process, from the prompt and from the spinner). Core
  now supports a cancel-the-run Ctrl+C, but wiring it into the terminal UI is separate work; the
  desktop app's Stop button is the intended consumer.

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

As built in D4:

- `SafetyChecker.authorize(command, { signal, toolCallId })` replaces `confirmIfDangerous`, which stays
  as a deprecated alias. `new SafetyChecker(true)` is `auto`, `(false)` is `ask-dangerous`;
  `autoApprove: true` is shorthand for `mode: 'auto'`, and `mode` wins when both are given. Sessions
  take `permissionMode` (same rule), `permissionStore`, `permissionsDir`, and expose `session.permissions`.
- The handler receives `{ command, reasons, dangerous, canAlwaysAllow, requester, toolCallId, signal }` and
  returns a `PermissionDecision`, a boolean (the older contract: `true` is allow once, `false` is
  deny, so the CLI is untouched), or `{ decision, match?, command? }`. Without a handler, anything that needs
  approval is denied.
- **Dangerous commands can never be allowlisted.** They prompt in every mode except `auto`, are not
  offered "always" (`canAlwaysAllow: false`), `allow_always` on one is treated as `allow_once`, and a
  destructive command that was written into the allowlist file by hand still prompts.
- `allow_always` saves the **exact command**. A host may choose a prefix rule instead (`match: 'prefix'`,
  e.g. `git status`), which covers that command plus plain arguments. After a prefix nothing may chain,
  redirect or substitute (semicolon, ampersand, pipe, angle brackets, backtick, dollar sign, newline),
  so `npm run build && rm -rf x` cannot ride on
  an allowed `npm run build`. A "prefix" that is not really a prefix of the command falls back to the exact command.
- **Where it is stored (changed from the first draft):** `~/.alia/permissions/<project>-<hash>.json`, not
  `<workspace>/.alia/permissions.json`. `.alia/` in a project also holds project skills, which teams
  commit; a committed allowlist would pre-approve commands for everyone who opens the repo. The file
  is plain JSON that names its project, is read on every check (so sessions on one project agree), is
  written atomically, and a damaged file grants nothing and is set aside on the next write.
- If the allowlist cannot be written, the command still runs this once.
- File writes outside the workspace are out of scope here; `write_file` and `edit_file` behave as today.

### 5.5 Session store (D5)

- Location: `~/.alia/sessions/<project>-<hash>/<id>.jsonl` plus `<id>.meta.json` (`title`, `titleSource`,
  `workspace`, `model`, `createdAt`; `updatedAt` is the file's modified time). It lives outside the project
  on purpose, so conversation content is never committed with the repo. The project folder name is the
  same helper the permission store uses (`projectFolderName`).
- Content: the OpenAI-format `messages` array, stored as it is in memory. A UI renders a past
  conversation from it (tool calls and results are already in there); diffs come from the change
  store (D7). The file is append-only, with three kinds of line, which cover every way the history
  changes: `msg` (a message was added), `set` (an older message was rewritten, which is how archived
  tool output is saved) and `replace` (the history was cleared or replaced).
- The agent reports every change through a new `onHistory` hook, and a `SessionRecorder` compares
  the live array with what it last saved (by reference) and writes only the difference.
- **Opt-in.** A session saves only when given a `sessionStore`; the CLI does not, so nothing new is
  written to a CLI user's home. The files are created with the first real message, so opening a window
  leaves nothing behind.
- API: `create`, `info`, `load` (returns `messages` and a `skipped` count), `list({ workspace?, limit? })`
  (newest first), `search(text, { workspace?, limit? })`, `rename`, `update({ model })`, `delete`, and
  `recorder`. Ids are checked (`[\w.-]+`), so an id can never name a path.
- Resume: `createSession({ sessionStore, resume: id })`. It loads the history and carries on in the same
  files. The session must belong to the same workspace. The model it used is restored unless `modelId`
  is given. **The system prompt is refreshed** (skills may have changed since); everything after it is
  exactly as it was, including pinned skill blocks and archived tool output. A new session can take a
  `sessionId`; `session.id` exposes the id.
- Titles: automatic, from the first user message (first line, at most 60 characters, cut at a word). A
  `/skill input` invocation becomes `/skill input` instead of the skill's boilerplate. `rename` marks a
  title as the user's, and an automatic title never replaces it.
- `/clear` really erases: a shorter history rewrites the file (atomically) instead of appending, and an
  automatic title that came from the erased text is dropped (a title the user chose stays).
- Search is a case-insensitive substring match over titles and over the text of user and assistant
  messages. Tool output and pinned skill text are left out (file dumps and playbooks would match almost
  everything). It reads each session file; there is no index in v1.
- Damage is contained: a line that cannot be read (a write cut short by a crash, or corruption) is
  skipped and counted, and after resuming, new entries start on a fresh line so they stay readable.
  A damaged meta file hides that one session from `list`, not the whole list. A store that cannot be
  written never stops the conversation.

Known limitations:

- Two processes writing to the same session are not coordinated (one window per session is assumed).
- `list` and `search` read files directly, so they will slow down with thousands of long sessions; an
  index can be added later without changing the API.
- A session records the model in use, but a model that is no longer in the config is not restored.

### 5.6 Command registry and `/compact` (D6)

- `session.commands` (a `CommandRegistry`) lists the built-ins (`help`, `tools`, `skills`, `models`, `model`,
  `clear`, `compact`, `tokens`), then the front-end's own commands, then one entry per available skill, each
  with `name`, `description`, `usage`, `acceptsArgs` and `kind: 'builtin' | 'skill' | 'host'`. The list is
  computed on every call, so it follows the skills and the registered tools. A front-end adds what only
  it can do with `commands.register(...)` (the terminal adds `exit` and `quit`; the desktop will add
  `config`). A built-in or front-end command wins over a skill of the same name, and `skippedSkills()`
  reports those.
- The terminal's slash menu is filled from this list (`setSlashCommands`), replacing the hard-coded array
  and `registerSkillCommands` in `prompt.ts`. A test asserts the menu equals the registry list.
- `session.compact({ keepRecent?, signal? })` (`/compact` in the terminal) replaces the older part of the
  history with a model-written summary and returns `compacted | nothing_to_compact | busy | failed | cancelled`.
  - **Kept verbatim:** the system prompt and the last 10 messages. The cut never lands on a tool result: it
    moves back to the assistant message that made the call, so the history stays valid for the API.
  - **Pinned skills survive.** A skill loaded through `use_skill` is moved to a user message (its tool call is
    summarized away); a `/skill` invocation stays as it was.
  - **One summary message** (`<conversation_summary>`) replaces the rest. Compacting again folds the earlier
    summary into the new one, so there is never more than one.
  - The transcript sent for summarizing is capped (about half the model's window), with tool output
    shortened, so compacting a huge history cannot overflow the model it is meant to relieve.
  - **It never makes things worse or loses work:** an API error, an empty summary, a cancel, or a summary
    that would not be smaller leaves the history untouched. Compaction is refused while a run is in
    progress (`busy`), and a run is refused while a compaction is in progress.
  - Emits `context_compacted` with `summarized`, `tokensBefore` and `tokensAfter`; the terminal prints it.
  - Saved sessions follow: the file is rewritten (the compacted turns are gone from disk) and the title is kept.
- `getContextUsage()` (built in D1) feeds the context meter. Switching model now also updates the pruning
  limit (`ContextManager.setMaxInputTokens`); before, it stayed at the first model's value.
- Not done: automatic compaction when the window fills. The existing pruning (archiving old tool output) still
  runs on its own; `/compact` is manual. It can be wired to a threshold later.

### 5.7 Change tracking and undo (D7)

- `write_file` and `edit_file` report each write through `ToolContext.recordChange`. `session.changes` (a
  `ChangeTracker`) keeps **one entry per file**: its content from before the agent first touched it, and as
  it is now, so several edits show as one diff. Subagents record into the same tracker.
- API: `list()` (order of first touch), `get(path)`, `diff(path)`, `revert(paths?)`, `keep(paths?)`, `size`.
  Paths may be written relative, `./`-prefixed, absolute, or (on Windows) in any case.
- `diff(path)` is a unified diff in `git diff` style (`--- a/x`, `+++ b/x`, `@@` hunks; `/dev/null` for a created
  file; "No newline at end of file" handled). It is computed with the small `diff` package, and the tests apply
  every generated patch with `git apply` to a copy of the original and require the result to equal what the
  agent wrote.
- `revert()` restores the old content byte for byte (CRLF included), or deletes a file the agent created along with
  the folders the write had to create, **if they are empty** (a folder that already existed, or that now holds
  someone else's file, stays). It returns `{ reverted, skipped }`.
- **It never overwrites work done after the agent.** A file whose content on disk is no longer what the agent
  wrote (edited or deleted since) is skipped as `modified` and stays pending. If someone else edits a file
  *between* two agent writes, their version becomes the new baseline, so Undo restores it and never discards it.
- `keep()` accepts changes (forgets them, files untouched); with paths, just those. Editing a file back to its
  original, or re-writing identical content, leaves nothing to review.
- **Not tracked, but shown:** a binary file, or one over 1,000,000 characters, is listed as `untracked`
  (no content kept, so no diff or undo; `revert` reports it as skipped). Files outside the workspace are tracked
  by absolute path.
- Without a tracker, tool events still carry the `changes` summary.
- Also fixed here: tool failures worded `Error writing file ...` (not `Error:`) are now reported as `isError`
  (`isToolErrorResult`), so the UI marks them as failed.

Known limitations:

- **`run_bash` writes are not tracked** (formatters, `sed`, build output, a file created with `>`). The Changes
  panel should say so; a git-snapshot fallback could cover it later.
- The tracker is **in memory**: pending changes do not survive restarting the app, so Undo is available for the
  current session only.

### 5.8 Document readers (D8, D9)

- `readDocument(path, { pages?, maxChars?, maxLines? })` returns `{ ok: true, kind, unit, text, totalPages, pagesShown, nextPage?, warnings }`
  or `{ ok: false, error }`; it never throws. Pure JavaScript (no native binaries), so Electron packaging stays simple.
  A document is read as a numbered series of **units**: pages (PDF), slides (decks) or parts (Word). The `pages`
  argument, the budget and the "continue with pages" instruction work the same for all three.
- **Provenance markers:** `[p. N]` (PDF), `[slide N]` (decks; `[slide N, hidden]`), `[part N: Heading]` (Word). The number
  is always the real one, also when a range is selected.
- **Chunks, never a silent cut:** a long document is returned unit by unit up to a budget (characters and lines), and the
  result says where to continue. `read_file` sizes the budget to the tool-output limits (16,000 characters / 250 lines by
  default), so the generic head-and-tail truncation, which would drop the middle of a document without saying so, never
  applies. The result ends with an exact instruction, for example `[Showing slides 1-6 of 40. Continue with pages: "7-12".]`;
  following it reads every unit exactly once. A single unit over the budget is cut and says so.
- `read_file` gained `pages` (`"3"`, `"3-5"`, `"1,4-6"`, `"7-"`, or a number) and a header such as
  `--- Document: brd.docx (DOCX, 8 parts) ---`.
- **PDF (D8):** `unpdf` (pdf.js), chosen after a spike on real PDFs. Pages are extracted one at a time, so a chunked read of a
  long BRD does not parse the whole file. A **scanned PDF** (no text layer) is refused with the reason and a note that OCR is not
  available (an error result); a mixed document is read, with `(no text)` for the empty pages and a warning listing them.
- **Word (D9):** read with `fflate` (zip) and a small purpose-built XML reader (no DTD or entity support, so no entity-expansion
  attacks; only the needed entries are inflated, and an entry over 40 MB is refused before it is inflated). Headings come out
  as `#` (resolved through the style *names*, so Portuguese-localized files work: their style ids are `Ttulo1`, their names are
  `heading 1`), plus outline levels; bullet and numbered lists with nesting and correct counts, including lists whose numbering comes
  from the style itself (`List Bullet`, `List Number`) or from a style they are based on; tables as pipe tables (merged cells keep
  the columns aligned, pipes escaped); tracked insertions are read and deletions are not; hyperlinks, content controls and text
  boxes are read; **reviewers' comments** are kept as a final `Comments` part, with their authors. Word has no stable page
  numbers, so the text is split into parts at each top-level heading, and every ~6,000 characters otherwise. Images are counted in a
  warning. Not extracted: headers, footers, footnotes.
- **PowerPoint (D9):** one entry per slide **in presentation order** (not file order): the title as `#`, the text of every shape
  (nested bullets keep their level), tables, image descriptions (`[image: ...]`), `[chart]`, group shapes, and the **speaker notes**
  after a `Notes:` line. A slide with only notes is kept. Footers, dates and slide numbers are left out. Hidden slides are marked
  and listed in a warning; slides with only undescribed images are flagged as missing content; a deck of pictures only is refused.
- **Recordings** (audio and video extensions) return "send a transcript (text) instead". The old binary formats **.doc / .ppt**
  are refused with "save it as .docx / .pptx". A corrupt, empty, password-protected (an encrypted Office file is not a zip) or
  oversized (over 60 MB) file is a clear error. These messages come from `read_file` and `@` mentions alike.
- **`@` mentions:** `resolveFileMentionsAsync` attaches a document as `<document path=... type="pdf|docx|pptx" pages|parts|slides="N"
  shown="1-30">` (up to the 100,000-character per-file limit, cut at a unit boundary, with what was left out named so it can be read
  with `read_file`). `session.prepareInput`, `session.resolveSkill` and a subagent's `inputs` use it, so they are asynchronous.
  The synchronous `resolveFileMentions` is unchanged and still treats a document as a binary file.
- **Paths with spaces** (real documents have them) can be mentioned with quotes: `@"Proposta Técnica 2026.pdf"`. Unquoted mentions
  behave as before. A subagent's `inputs` quotes such paths automatically.
- Checked against a genuine Word file produced by `python-docx` as well as the synthetic fixtures; that exposed the style-based list
  gap above. Not checked against files produced by Word or PowerPoint themselves, so real decks (SmartArt, charts) may hold text this
  does not reach.

### 5.9 `ask_user` and gate questions (D10)

```ts
ask_user({ questions: [{
  id: string,
  kind: 'choice' | 'text' | 'confirm',
  prompt: string,
  options?: [{ id, label, detail?, source? }],   // choice only, at least two; source: "BRD_v2.pdf · p. 14"
  allowOther?: boolean,                           // choice: also accept an answer that is not an option
  allowDefer?: boolean,                           // "Adiar: registrar como suposição"
  confidence?: 'low' | 'medium' | 'high',
}] })
// -> { "answers": [{ id, answer, label? } | { id, deferred: true, owner }],
//      "unanswered"?: [ids], "note"?: "..." }
```

As built in D10:

- `createSession({ onAskUser })`: the handler receives `{ questions, toolCallId, signal }` and returns `UserAnswer[]`
  (`{ id, answer?, deferred?, owner? }`). **The tool exists only when a handler is given**, so a host without one never
  offers it and skills fall back to asking in plain text. A hand-built registry with no handler gets an error that tells
  the model to ask in plain text and never invent answers.
- **The model's questions are validated** (1 to 10; unique ids; a choice needs two or more options with ids and labels;
  options only on choices), and an invalid set is an error for the model **without ever bothering the user**.
- **The front-end's answers are validated too**: a choice answer must be one of the options (or free text if `allowOther`), a confirm
  must be a boolean, text must not be blank, deferral needs `allowDefer`, unknown ids are refused. A mistake in a front-end becomes a
  visible error, not a silently wrong answer.
- **Partial answers are normal** (the design's "Responder depois"): questions left out come back in `unanswered`, with a note
  telling the model to stop at that gate and say what is waiting. A deferral without an owner is passed on with `owner: null` and a note to
  ask who owns the assumption before recording it (the pipeline skill records deferrals as assumptions with an owner).
- A choice answer carries its option `label`, so the model does not have to map ids back.
- **Cancelling closes the questions**: the run does not wait on them, and the front-end gets the `signal` so it can dismiss its cards.
- **Subagents never get it** (`without`): a child that calls it gets an error that says to decide or stop at the gate (`STATUS: blocked`).
- **The skill notes follow the real tools.** `HARNESS_NOTES` is now generated from the tools that exist for whoever will follow
  the skill: with `ask_user`, `AskUserQuestion` maps onto it (with the "stop on unanswered" rule); with `run_subagent`, `Task` maps onto it;
  otherwise it says plainly that neither exists. This also fixes a stale line that told the model there was no subagent tool.
  Because a subagent has fewer tools than its parent, `ToolContext.toolNames` tells each tool which tools its caller has, so a skill
  pre-loaded into a child, or loaded by the child through `use_skill`, is described correctly (no `ask_user`, no `run_subagent`).
  The pipeline skill already lists `AskUserQuestion`, so it needed no edit.
- **Terminal:** `cliAskUser` asks the questions one at a time (a number or option name; `y/n`; text; `d` to defer, then the owner;
  Enter skips). It reads lines through a queue because `readline`'s `question()` drops lines that arrive while no question is pending,
  which is what piped input does; input that ends early leaves the rest open instead of hanging; three invalid tries leave a question open.
  The CLI now offers `ask_user`, so `/requirements-to-tasks-pipeline` asks its gate questions as structured questions in the terminal.
- Not done: an event for "questions asked / answered" (the tool call and its JSON result already appear in the stream, and a front-end
  receives the questions directly through the handler).

### 5.10 Pipeline state (D11, D12)

`STATE.md` is prose that a model writes freely, so a UI cannot rely on it. The machine-readable file is the source of truth and
the prose is rendered from it:

- `docs/pipeline/state.json` (version 1) holds: `inputs` (name, version, kind, handling skill, and, when a path is given, the
  file's SHA-256 and size at the time it was inventoried), the four `stages` (skill, status `pending | running | done | blocked | stale`,
  artifact, reasons), the three `gates` (`pending | open | passed`) with their **questions** (id, prompt, kind, category
  `open_question | contradiction | low_confidence | blocker`, options with sources, confidence, status `open | answered | deferred`,
  answer, label, by, date, owner), `specReviews` (the human review behind gate 3), `decisions`, `assumptions` (owner, stage, the
  question they came from), `adrs`, and `notes`.
- **`pipeline_state` tool** (`action: "get" | "update"`). `get` returns the state, the gates' progress, what is waiting, and the task
  counts. `update` applies a list of **operations** in order, all or nothing (the input is never touched, and a failing batch changes
  nothing): `set_project`, `add_input`, `set_stage`, `add_question`, `answer_question`, `defer_question`, `reopen_question`, `set_gate`,
  `set_spec_review`, `add_assumption`, `add_decision`, `add_adr`, `add_note`, `mark_stale`. (The first draft said "update with a
  patch". Typed operations are used instead: a small model is far more reliable filling in "answer this question" than producing a
  merge patch over a nested document, and every operation can be validated with an error that says what to fix.) The tool is
  offered in every session; its description limits it to the pipeline.
- **It enforces the skill's rules**: a stage cannot start or finish until the previous stage is `done` **and its gate has passed**; a
  gate cannot pass while a question is open (the error names them), and gate 3 also needs every spec reviewed; a blocked or stale stage needs
  a reason; **a deferred question needs an owner and becomes an assumption automatically** (answering or reopening it removes the
  assumption); a new question reopens a gate that had passed; `mark_stale` marks the stages after a changed artifact as stale, with the reason,
  and makes their gates pass again. These are the rules from `SKILL.md`, now refused in code instead of hoped for.
- **STATE.md is regenerated on every update**, by a pure function (the same state always gives the same text), including the stage-4
  row `docs/tasks/ (11 tasks, 45 points)`, the open questions, the decisions and answers, the assumptions with owners, spec reviews,
  ADRs, and any backlog problems. `state.json` is always written in one canonical layout (no reshuffling in a committed file). A damaged
  `state.json` is an error and is never overwritten. The files are written atomically.
- **Task numbers are computed, not counted by the model.** `summarizeTasks()` reads `docs/tasks/*-tasks.md` in the format `spec-to-tasks`
  writes (`### <title>` blocks with `**Slice:**`, `**Story points:**`, `**Depends on:**`) and returns tasks, points and per-spec totals. It copes
  with the ways titles carry ids (`1.2 Title`, `T1.2 — Title`, `Task 1.2: Title`), `5 pts`, Windows line endings, and code blocks (an
  example inside a task is not a task), and it reports **problems**: points missing, off the Fibonacci sequence or above 8, duplicate ids,
  dependencies on things that are not tasks (resolved by id or title, in the same file or another), dependency cycles, files with no tasks.
  It is tested against a golden backlog (4 specs, 11 tasks, 45 points) and a golden `STATE.md`.
- `SKILL.md` for the pipeline now says: use `pipeline_state` when available (inputs with a `path`, questions before asking, answers and
  deferrals after), otherwise write `STATE.md` by hand.
- **Status and resume (D12):** `getPipelineStatus(workspace)` (and `session.pipelineStatus()`) answers "where did this stop, and what is next?"
  from `state.json` alone. It never throws and changes nothing. It returns the stages and gates with their progress, a one-line `summary`
  ("Waiting at gate G1: 3 of 5 questions answered."), the task counts, and `next`, the **first thing that is not finished, in pipeline order**:
  `inputs_changed`, `answer_questions` (the gate and exactly the open questions), `review_specs` (gate 3), `pass_gate` (the user has not
  approved moving on), `run_stage` (to start, continue, unblock or **redo if stale**), `complete`, or `not_started` / `damaged`. Earlier work
  comes first: a question reopened at gate 1 is next even if stage 4 is done.
- **Changed inputs are noticed.** `add_input` records a file's hash; the status compares it with the file now and reports `changed` or
  `missing`. A changed input takes precedence over everything (the answers may no longer hold), and the resume prompt tells the model to ask the
  user whether to redo from stage 1 (`set_stage` stale, then `mark_stale`) and to refresh the inventory (`add_input` again). Inputs without
  a file are never flagged. The status itself changes nothing: the decision is the user's.
- **A ready-made resume prompt.** `status.resumePrompt` says where it stopped and what to do, listing only the *open* questions ("do not
  ask them again"), and how to record the answers (`ask_user`, `answer_question`, `defer_question` with an owner, `set_gate` only when none is
  open and the user approves). `session.resumePipelinePrompt()` returns that text with the pipeline skill already loaded (or the plain text if
  the skill is unavailable, or nothing when there is no state); pass it to `run()`. The test restarts the session (as a closed app would),
  resumes a pipeline stopped at gate 1 with 3 of 5 answered, and the new run asks only the two open questions and closes the gate.
- **STATE.md drift:** the status reports whether STATE.md matches what `state.json` renders to (`ok`, `differs`, `missing`). `differs` usually means
  it was edited by hand (a small model that ignored the tool), or that the task files changed (their counts are computed). Line endings alone are not
  drift. `refreshStateMarkdown(workspace)` regenerates it.

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
| D3 | **Done.** Cancellation via `AbortSignal` (loop, API call, `run_bash`, subagents) | 3 | Aborting mid-API-call and mid-`run_bash` ends the run with `cancelled` within a second, kills the child process, and leaves history valid (no dangling `tool_call_id`). A following `run()` works. |
| D4 | **Done.** Permission model v2: decisions, modes, per-project allowlist | 5 | `allow_always` persists and applies on the next session; dangerous commands still prompt in `ask-dangerous` and `ask-commands`; `auto` skips prompts; legacy boolean handler still works; the permission event carries the tool-call id. |
| D5 | **Done.** Session store (JSONL), resume, list, search, rename | 5 | A run is persisted and `resume` reproduces the same `messages`. `list` filters by workspace; `search` finds text in titles and messages. A corrupted last line is skipped, not fatal. Nothing is written inside the workspace. |
| D6 | **Done.** `CommandRegistry`, `/compact`, `getContextUsage()` | 3 | CLI prompt and a test consumer read the same command list (built-ins plus skills). `/compact` shrinks a long history, keeps system prompt, pinned skills and recent turns, and the run continues correctly afterwards. |
| D7 | **Done.** `ChangeTracker`: record, diff, revert, keep | 5 | `edit_file` and `write_file` record before/after; `diff` returns a unified diff; `revert` restores or deletes; revert skips a file modified after the agent's change and reports it; `keep` clears the list. |
| D8 | **Done.** `readDocument` for PDF with page markers; integrate into `read_file` and `@` mentions | 5 | A sample multi-page PDF reads with `[p. N]` markers; `pages` argument works; a scanned PDF returns the no-text-layer message; audio/video return the transcript message; `@file.pdf` attaches text. |
| D9 | **Done.** `readDocument` for DOCX and PPTX (slides and speaker notes) | 3 | Sample DOCX keeps headings and tables as readable text; PPTX output has `[slide N]` markers and includes notes; both work through `read_file` and `@`. |
| D10 | **Done.** `ask_user` tool, `onAskUser` handler, HARNESS_NOTES mapping | 5 | With a handler, questions round-trip as structured answers (including a deferral with owner); without one the tool errors with the plain-text fallback instruction; it is absent in subagents; the CLI implements a basic handler. |
| D11 | **Done.** `pipeline_state` tool, `state.json` schema, `STATE.md` rendering, derived task stats | 5 | Updates validate against the schema and re-render `STATE.md`; stats (tasks, points, per spec) match a golden `spec-to-tasks` sample; the pipeline skill carries the one-line instruction and still works without the tool. |
| D12 | **Done.** Pipeline status and resume, with stale-input detection | 3 | Given a state file stopped at Gate 1 (3 of 5 answered), `getPipelineStatus` reports that, and a resumed session continues from the open questions. A modified input file is flagged `stale`. |
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
| `allow_always` becomes a hole. | Dangerous patterns are never allowlistable (even by hand-editing the file); rules are exact commands by default, prefix rules refuse shell operators; the allowlist is per user and project, kept outside the repo, human-readable JSON, and shown in the settings screen (backlog 003) through `session.permissions`. |
| Revert overwrites user edits. | D7 compares disk content with `after` first and skips conflicts. |
| Session files hold sensitive document content. | Stored under `~/.alia`, outside the repo; opt-in (the CLI writes nothing); `delete` is a first-class operation; `/clear` rewrites the file so erased text is really gone (D5). |

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
