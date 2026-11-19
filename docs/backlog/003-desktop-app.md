# Backlog 003: Desktop app (Electron)

| | |
|---|---|
| **Status** | In progress. Done: A13 (structured summaries in `core`; `npm run test:pipeline`), A1 (scaffold; `npm run desktop:smoke`), A2 (engine, IPC contract and validation; `desktop:test:engine`, `desktop:test:app`), A3 (shell and hardening; `desktop:test:security`, `desktop:test:hardening`, `desktop:test:package`), A4 (settings and secrets; `desktop:test:settings`, `desktop:test:settings-app`), A5 (projects, trust, sidebar, conversations; `desktop:test:projects`, `desktop:test:ui-logic`, `desktop:test:sidebar-app`), A6 (chat timeline; `desktop:test:timeline`, `desktop:test:timeline-app`) and the part of A0 that did not need the design owner (logos, fonts, tokens). Proposals P1-P7 are being followed as recommended until someone says otherwise. Next: A7 (composer), A8 (permission card), A9 (past conversations) and A10 (right panel) in any order; A16 grows with each. A0 still needs the color and string-list sign-off. See section 11 for what was built and where it departs from this document. |
| **Depends on** | Backlog 002 (done): `createSession` and everything on it, plus the pipeline state and status APIs |
| **Design** | `alia Harness Desktop.pdf`, 8 screens (listed in section 3). The PDF is flattened screenshots, so colors and type below are sampled, not specified |
| **Primary consumer** | People at Instituto Atlântico on Windows 11 who turn BRDs, SOWs and transcripts into a backlog (the pipeline), and who use the agent on a code project (chat) |

## 1. Problem

`core` is now embeddable and the CLI proves it. What does not exist is the product in the design: a window with
a chat, a permission card, a Changes panel, and above all the **pipeline wizard**, where a person drops
documents, answers gate questions, reviews specs and ends with a backlog. This item builds that app as a thin
front-end over `core`, the way `cli/` is.

## 2. Goal and non-goals

Ship a Windows desktop app that does everything the 8 screens show, with the engine isolated from the UI, secrets
stored safely, and an installer people can run without admin rights.

### Non-goals (v1)

- macOS and Linux builds. The code stays portable, but only Windows is packaged and tested.
- Dark theme. The design is light only (sampled palette in 5.A0); tokens are set up so a dark theme can follow.
- Languages other than pt-BR in the UI. Strings live in one catalog so another language is a data change.
- An MCP client (backlog 001, section 8). "Publicar issues" uses what 002/D13 detects: a signed-in `gh`/`glab`, or drafts.
- Parallel subagents, OCR, audio transcription, auto-update (section 9 explains the last one).
- An interactive terminal. The Terminal tab is a read-only log of the agent's commands (decision, 002).
- Editing files by hand. The app shows diffs and files; people edit in their editor.

## 3. The design, screen by screen, and what powers each part

| # | Screen | What it shows | Where the data comes from |
|---|---|---|---|
| 1 | **Home** | Greeting ("Boa tarde, Newton"), composer, project chip, model chip, pipeline card, suggestion chips, sidebar (Nova conversa, search, pipeline sessions with a gate chip, projects, recents) | `SessionStore.list/search`, `getPipelineStatus` per project, settings (name, organization), `session.getModel()` / `listModels()` |
| 2 | **Chat** | Turns, tool rows ("Leu 2 arquivos", "Editou x +7 -4", "Executou npm test passou" with output), permission card, composer with Stop, orange dot on a conversation waiting for approval, right panel **Alterações / Arquivos / Terminal**, bar "Desfazer / Manter alterações" | `onEvent` (`tool_call_*` with `changes`, `permission_*`, `model_*`), `session.changes` (list, diff, revert, keep), `onConfirm`, `session.permissions` |
| 3 | **Pipeline: new session** | The 4 stages with their gates, target project, banner "Este projeto já tem um STATE.md. A sessão anterior parou no Gate 1. Retomar sessão", drop zone, each input classified with its skill, recordings refused with "Anexar transcrição", "Iniciar pipeline" | `getPipelineStatus` (resume banner), input classification (new, A11), `PipelineStateStore.apply` (inventory first), `readDocument` kinds |
| 4 | **Pipeline: gate 1** | Stepper (Entradas, 1-4) with per-stage status, status chip, skill/tool rows, **gate card** with answered questions collapsed, the current one with options and sources, a free-text question where blank means "register as assumption", "Responder depois" and "Enviar e seguir", right panel (artifacts, inputs, assumptions, "contexto do modelo") | `PipelineState` (gates, questions, assumptions), `onAskUser`, `getPipelineStatus.next`, `session.getContextUsage` |
| 5 | **Pipeline: gate 2** | "Arquitetura proposta" (style, contexts), ADRs with status, gate card "Revisão da arquitetura" with an "Aprovar com notas" chip, ADR alignment rows (Alinhado / Desalinhado), a blocking question, a note that non-blocking items become assumptions | `adrs`, gate questions with `category: 'blocker'`, **structured architecture summary (new, A13)** |
| 6 | **Pipeline: gate 3** | Spec table (persona, depends on, status, who and when), a spec preview (problem, acceptance criteria, out of scope, slices), review comment, "Pedir alterações / Aprovar spec / Seguir para Tarefas" (disabled until all reviewed), a green "lacuna resolvida" notice | `specReviews`, **structured spec summaries (new, A13)**, `set_spec_review`, `set_gate` |
| 7 | **Pipeline: done** | Backlog per spec with ids, points and dependencies, "Checagem entre specs" (3 checks), "Relatório final" (4 specs, 11 tarefas, 45 pontos, 3 ADRs), assumptions with owners, ADRs, "Abrir docs/tasks/", "Publicar issues" | `summarizeTasks` (counts, problems), **cross-checks (new, A15)**, `session.issuePublishing()` |
| 8 | **Menus** | `/` command list (/help, /model, /clear, /compact, /config) and `@` file list with "pasta inteira" | `session.commands.list()` plus host commands, `FileIndex.search` |

Window chrome: a custom title bar (logo, "Harness v1.0.0", minimize/maximize/close) drawn by the app.

## 4. Architecture

### 4.1 Process model (proposed, see decision P1)

```
 Renderer (React, sandboxed, no Node)  <--- typed IPC (contextBridge) --->  Main (broker)  <--- MessagePort --->  Engine (utilityProcess, Node)
   screens, state, markdown               preload exposes window.alia            windows, menus, dialogs,           createSession(...), tools,
                                                                                  safeStorage, validation            skills, documents, files
```

- **Engine in a utility process, not in main.** Reading a PDF takes about half a second of CPU per few pages, a tool can run for minutes,
  and a runaway command must not freeze the window or the menu. A crash in the engine shows an error and restarts it; the renderer
  and main survive. (Cancellation already kills process trees, 002/D3.)
- **Main is a thin broker.** It owns the windows, native dialogs (open folder, choose files), `safeStorage`, the app menu, and validates every
  message from the renderer before forwarding it. It holds no conversation state.
- **The renderer cannot touch the machine.** It has no Node, no file system and no network of its own; everything goes through
  `window.alia`, a small typed API.

### 4.2 The IPC contract

One module of types shared by all three sides (`desktop/shared/ipc.ts`), validated at runtime in main (never trust the renderer).

**Requests** (renderer to engine, with a reply): `session.open { projectPath, resumeId? }` / `session.close`, `session.run { sessionId, prompt, attachments }`,
`session.cancel`, `session.compact`, `session.reset`, `model.list` / `model.switch`, `commands.list`, `files.search { query }`,
`changes.list` / `changes.diff` / `changes.revert` / `changes.keep`, `permissions.list` / `permissions.remove`,
`conversations.list` / `search` / `rename` / `delete` / `load`, `pipeline.status` / `pipeline.start { inputs }` / `pipeline.resume` /
`pipeline.approveGate { gate }` / `pipeline.reviewSpec { spec, status, comment }`, `issues.detect` / `issues.publish { mode }`,
`settings.*` (in main).

**Events** (engine to renderer): every `AgentEvent`, tagged with `sessionId`. Two kinds of event need an answer, and are modeled as
request/response pairs with an id: `permission_requested` (answered with allow once / always / deny) and the `ask_user` questions
(answered with the answers). Cancelling a run resolves any open one as dismissed (core already provides the signal).

**Rules:** every payload has a schema; unknown fields are rejected; paths from the renderer must be inside a project the user opened through the
native dialog (main keeps that list); sizes are capped (a diff or tool output is sent as a reference and fetched on demand, not pushed whole).

### 4.3 Security checklist (acceptance for A3)

`contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for every renderer; a strict CSP with no remote scripts, styles or fonts
(fonts are bundled); `will-navigate` and `setWindowOpenHandler` deny everything, external links open in the system browser only for `https:`
after the user's click; no `webview`; Electron fuses set (no `runAsNode`, no `NODE_OPTIONS`, ASAR integrity on); model and document text is
rendered as markdown **without raw HTML** (sanitized), so a malicious PDF cannot inject UI; the API key never leaves main/engine; project-level
skills (`<project>/.alia/skills`) load only after the user trusts the folder (A5), because a skill is instructions the agent follows.

### 4.4 Where things live

| What | Where |
|---|---|
| Conversations | `~/.alia/sessions` (002/D5), shared with the CLI |
| Per-project allowlist | `~/.alia/permissions` (002/D4), shared with the CLI |
| App settings (endpoint, models, display name, organization, recent projects, window state) | `%APPDATA%/<app>/settings.json` |
| API key | encrypted with `safeStorage` (Windows DPAPI) in `%APPDATA%/<app>/credentials.bin`, decrypted only in main and handed to the engine in memory |
| Logs | `%APPDATA%/<app>/logs/` (no conversation content, no keys) |
| Bundled skills | the app's `resources/skills`, passed as `skillRoots` (the core default assumes the repo layout) |

### 4.5 Repository layout (proposed, see decision P2)

npm workspaces: the root keeps `src/core` + `src/cli` (small, no Electron), and `desktop/` is a second package (`main`, `engine`, `preload`,
`renderer`, `shared`) that depends on `alia-harness/core`. This keeps Electron out of the CLI's install.

## 5. Decisions

### Made (earlier)

| # | Decision |
|---|---|
| 1 | Renderer stack is React + Vite via `electron-vite`. |
| 2 | The pipeline runs in a single conversation for v1 (the design says so); resume comes from `state.json`. |
| 3 | The Terminal tab is a read-only log of the agent's commands. |
| 4 | "Publicar issues" publishes through a registered issue tool or a signed-in `gh`/`glab`; otherwise it warns, then saves drafts in `docs/issues/`. |
| 5 | The desktop default permission mode is `ask-commands`. |

### Proposed (confirm before the tasks they affect)

| # | Proposal | Why | Affects |
|---|---|---|---|
| P1 | Run the engine in a `utilityProcess`, main as broker (4.1). | CPU-heavy documents and long tools must not freeze the UI; crash isolation. Cost: a bit more IPC plumbing. | A2 |
| P2 | npm workspaces with a separate `desktop/` package (4.5). | Electron stays out of the CLI. | A1 |
| P3 | **Structured summaries in `state.json`** for the architecture, each spec, ADR alignment and cross-checks, recorded by the model through typed `pipeline_state` operations (same approach as 002/D11), with the rendered markdown as a fallback. | The architecture and spec skills write loosely structured prose (labelled sections, no fixed schema), so parsing it would be guesswork; the design needs real fields. | A13, A14, A15 |
| P4 | Light theme only for v1. | The design is light only. | A0 |
| P5 | Background runs: several conversations may run at once (core isolates sessions); the sidebar shows a spinner, and an approval or question raises a badge (the orange dot in the design). | The design already has the badge. Lets a pipeline run while the user chats elsewhere. | A5, A8 |
| P6 | Per-user installer (no admin rights) plus a portable zip; no auto-update in v1. | Corporate machines restrict installs; updates need hosting nobody has decided on. | A17 |
| P7 | pt-BR UI with all strings in one catalog; agent-facing prompts stay in English. | The design is in Portuguese. | A18 |

## 6. Gaps between the design and the code that exists

| Gap | Resolution |
|---|---|
| Architecture panel, spec table/preview, "Aprovar com notas" and ADR alignment need structured data; the skills write prose | P3: new `pipeline_state` operations (A13); markdown fallback |
| "Checagem entre specs": two checks are computable (points within 8 and Fibonacci, dependencies without cycles); "every acceptance criterion is covered" and "dependencies follow story dependencies" are semantic | Compute what can be computed (`summarizeTasks.problems`); the model records the others as cross-checks with `pipeline_state` (A15) |
| A text question left blank means "register as assumption"; core requires an owner for a deferral | The UI supplies the owner (the user's display name, editable); blank is never sent as "unanswered" (A12) |
| "Lacuna resolvida" notice (green) and the skill tree with "Não necessário" rows come from the model's own text | v1 renders the assistant message normally and shows `use_skill` calls as nested rows; no special card. A structured "skill step" event is a later option |
| Past conversations lose the "+7 -4" and durations (they are in events, not in the saved messages) | A9 stores small annotations next to the saved messages |
| The installer cannot assume Git Bash or Python (`run_bash` prefers Git Bash on Windows; a skill ships Python scripts) | A17 adds a diagnostics screen and a clear message when they are missing |
| `bundledSkillsDir()` assumes the repo layout | Pass `skillRoots` from the app (A2); no core change |
| No streaming: the assistant's text appears when a step ends | Acceptable for v1 (spinner via `model_started/finished`); A19 is optional |
| The `@` mention syntax cannot hold a path with spaces without quotes | Solved in 002/D8 (`@"..."`); the composer inserts quotes automatically (A7) |

## 7. Tasks

Points are Fibonacci, capped at 8, matching `spec-to-tasks`. "Core" marks a task that also changes `src/core`; those come with tests in the core suites.

| ID | Task | Pts | Acceptance criteria |
|---|---|---|---|
| A0 | **Partly done** (see 11). Design tokens and assets | 3 | Sampled palette checked against the design owner (primary blue about `#2f61c0`, selected `#dde6f7`, sidebar `#edf0f5`, background `#f6f7f9`, warning card `#fff6ed` and orange `#c25d00`, success `#1c7a3b`, diff add `#e8f3ea` / remove `#fdebeb`, terminal `#121826`); type (a UI sans, apparently Inter, and a monospace) confirmed and bundled offline; the alia and Atlântico logos obtained as SVG; spacing/radius scale and the full pt-BR string list written down. Output: a tokens file and a checklist per screen |
| A1 | **Done** (see 11). Scaffold: workspaces, `electron-vite` (main, engine, preload, renderer), scripts | 5 | `npm run dev` opens a window with the engine started and a "ping" round trip; typecheck, build and lint cover all packages; CLI install does not pull Electron; **an unsigned installer builds and launches on a clean profile with `core` imported** (finds ESM, ASAR and path problems on day one) |
| A2 | **Done** (see 11). Engine process, IPC contract, validation, event bridge | 8 | Types in `shared/ipc.ts`; every request has a schema and unknown fields are rejected; sessions are created per project with the app's `skillRoots`, `sessionStore`, `permissionMode: 'ask-commands'`, `onEvent`, `onConfirm`, `onAskUser`; events reach the renderer tagged by session; the engine restarts after a crash without losing saved conversations; a cancel kills the running command (a test runs a real long command) |
| A3 | **Done** (see 11). Shell and hardening | 5 | Custom title bar and window controls as in the design; single-instance lock; app menu and shortcuts (Ctrl N); everything in 4.3 verified by a test that tries to navigate, open a window, and call Node from the renderer and fails; logs with no secrets |
| A4 | **Done** (see 11). Settings, config and secrets | 5 | The `/config` screen: endpoint URL, models (id, name, context size), display name, organization, default permission mode; API key stored with `safeStorage` and never sent to the renderer; "test connection" lists the endpoint's models; first-run import from an existing `alia-config.json` / `.env`; the allowlist per project can be listed and removed (`session.permissions`) |
| A5 | **Done** (see 11). Projects, trust, sidebar, conversations | 5 | Open folder, recent projects, switching projects; a one-time "trust this folder?" before project skills load; conversations list from `SessionStore` (newest first, by project), search, rename, delete; Ctrl N; the greeting by time of day with the display name; pipeline sessions listed with their gate chip from `getPipelineStatus`; per P5 the sidebar shows running and waiting states |
| A6 | **Done** (see 11). Chat timeline | 8 | Events become rows: "Leu N arquivos" (consecutive reads grouped), "Editou/Gravou path +a -r" from `changes`, "Executou cmd" with a collapsible output and passou/falhou from the exit code, `use_skill` and `run_subagent` as nested rows, final answers as markdown; a spinner while `model_started` is open; errors and "Run cancelled" shown; markdown sanitized (no raw HTML, links confirmed); the model chip and context meter (`getContextUsage`); unit tests for the event-to-row mapper with recorded event sequences |
| A7 | Composer | 5 | Multi-line input, Enter sends, Shift+Enter newline; `@` menu from `files.search` with "pasta inteira" and Tab/Enter behavior as in screen 8, inserting `@"path"` when the path has spaces; `/` menu from `commands.list()` plus the host commands (`config`); `/model`, `/clear`, `/compact`, `/config` do what the CLI does; attached files as chips; drag and drop (paths resolved in the preload); Stop while running cancels the run; input history |
| A8 | Permission card and questions plumbing | 5 | `permission_requested` shows the card in the timeline: Permitir uma vez / Sempre permitir neste projeto / Negar; a dangerous command hides "always" and says why; several requests queue; the card is dismissed on cancel or when `permission_resolved` arrives; the same plumbing delivers `ask_user` requests to whatever view is showing (generic card for chat, gate card for the pipeline); a request from a background session raises the sidebar badge instead of stealing focus |
| A9 | Past conversations | 5 | **Core:** the session store saves small annotations next to the messages (tool-call changes and durations) and returns them on load; opening a conversation resumes it (`resume`) and renders the same timeline from messages plus annotations; a conversation that was waiting for approval says it was interrupted rather than showing a dead card |
| A10 | Right panel: Alterações, Arquivos, Terminal | 8 | **Alterações:** the changed files with +/- counts, a unified diff view (inline, horizontally scrollable as in the design) from `changes.diff`, "Desfazer" and "Manter alterações" (all or per file), conflicts reported when a file was edited since, "untracked" files listed without a diff, and a visible note that changes made through commands are not tracked. **Arquivos:** the project tree (built from `FileIndex`) with a read-only preview. **Terminal:** a read-only log of `run_bash` commands with output and exit codes. The panel toggles with the "Painel" button |
| A11 | Pipeline: intake | 5 | **Core:** a small `classifyInput(path)` (document / transcript / short request / recording, from extension and size) and `startPipelinePrompt(inputs)`, mirroring `resumePipelinePrompt`. **UI:** target project selector, the resume banner when `getPipelineStatus` says a state exists, drag and drop or "Escolher arquivos", each file shown with its class and the skill that will read it, a recording refused with "Anexar transcrição" (attaches a transcript for it), unreadable files (scanned PDF, `.doc`) explained using `readDocument`'s own messages, the inventory (names, kinds, hashes) written to `state.json` **before** anything runs, then the run starts |
| A12 | Pipeline: run view and the gate card | 8 | The stepper (Entradas, 1-4) with the status and gate progress of each stage from `getPipelineStatus`; the status chip ("Aguardando suas respostas / sua decisão / revisão das specs / Pipeline concluído"); "Pausar" cancels, "Retomar" uses `resumePipelinePrompt`; the **gate card** lists answered questions collapsed (from state) and the open ones with options and sources, categories ("Contradição entre documentos", "Baixa confiança", "Bloqueia as specs"), "Adiar" as a deferral with an owner (default: the user) and a blank text answer sent as that deferral; "Responder depois" returns the answers given so far; "Enviar e seguir" submits and, when the gate is clean, calls `set_gate` **directly** through `PipelineStateStore` (a human approval, not something the model does) and continues; the right panel shows artifacts (open with the system), inputs, assumptions and the context note; STATE.md opens from the header |
| A13 | **Done** (see 11). **Core:** structured pipeline summaries | 5 | New typed `pipeline_state` operations and `state.json` fields: `set_architecture` (style, driver, contexts, recommendation such as "Aprovar com notas"), `set_adr_alignment` (ADR, aligned / misaligned, note), `set_spec` (slug, title, persona, depends on, constraints); `pipeline_state get` returns them; STATE.md renders them; the pipeline skill is updated to record them (and to fall back to prose when the tool is missing); the status keeps working for states without them; golden files updated |
| A14 | Pipeline: architecture and specs screens | 8 | **Gate 2:** "Arquitetura proposta" and the ADR list from the structured summary (markdown fallback when absent), the review card with the recommendation chip and ADR alignment rows, the blocking question, non-blocking items listed as assumptions. **Gate 3:** the spec table (persona, depends on, status, who and when) from `specReviews` + `set_spec`; "Revisar" opens the spec preview (problem, acceptance criteria, out of scope, slices, rendered from the spec file); the review comment; "Aprovar spec" records `set_spec_review`; "Pedir alterações" sends the comment to the agent and reopens the stage (`mark_stale`) after confirmation; "Seguir para Tarefas" stays disabled until every spec is reviewed, then passes G3 directly |
| A15 | Pipeline: final report, cross-checks and publish | 5 | **Core:** `pipeline_state` `set_check` (key, status, detail) and `summarizeTasks` extended to check task dependencies against story dependencies. **UI:** the backlog by spec (ids, points, dependencies) from `summarizeTasks`; "Checagem entre specs" combining computed checks (points, cycles, dependency consistency) with the model-recorded one (acceptance criteria coverage), each failing check explained; "Relatório final" (specs, tasks, points, ADRs) and "Nada bloqueado" / what blocks; assumptions with owners; "Abrir docs/tasks/"; **"Publicar issues"** calls `session.issuePublishing()` at every attempt: with `mode: 'publish'` it runs the suggested skill, otherwise it shows the warning (why, the exact fix, where drafts go) and runs in draft mode only after the user confirms |
| A16 | Test harness and end-to-end tests | 5 | A local fake OpenAI-compatible server (scripted turns, tool calls, hangs) the app can be pointed at; Playwright-for-Electron tests for: first run and settings, open a project and chat with a tool call, approve and deny a command, cancel mid-command, undo a change, resume a conversation after restart, the whole pipeline through all three gates with the fake model, publish falling back to drafts; screenshots of every design screen stored for review |
| A17 | Packaging and distribution | 5 | `electron-builder`: per-user NSIS installer and a portable zip; skills, fonts and icons in `resources`; Electron fuses; version from `package.json`; the installer is smoke-tested on a clean Windows 11 profile; a diagnostics screen reports Git Bash, Python (for the skills that need it) and the endpoint, with instructions when missing; code-signing wired in but optional until a certificate exists (section 9) |
| A18 | Polish: accessibility, keyboard, states, performance | 5 | Keyboard use throughout (menus, cards, tabs, Esc closes), focus order and visible focus, labels for screen readers, contrast checked against the sampled palette; empty, loading and error states for every list and panel; a long conversation (thousands of rows) stays smooth (virtualized timeline) and a very large diff does not freeze the panel; pt-BR strings only from the catalog |
| A19 | *(optional)* Streaming of assistant text (D14) | 5 | Core emits `assistant_delta` / `thinking_delta`; the timeline renders them live and falls back to non-streaming when the endpoint cannot stream |

Total: 108 points (113 with A19).

### Order and phase gates

```
A0 -> A1 -> A2 -> A3          Foundation. Nothing else starts before A1; A2 and A3 can overlap once the scaffold runs.
A13 (core)                    Independent of the UI: start it early, it unblocks A14/A15.
A4, A5                        Need A2 and A3. A4 first (the app cannot talk to a model without settings).
A6 -> A7, A8, A9, A10         Phase 1, chat. A6 first; A7-A10 follow in any order. A16 starts here and grows with each screen.
A11 -> A12 -> A14 -> A15      Phase 2, the pipeline wizard. Needs A5, A8 (the gate card is the questions plumbing) and A13.
A17                           Early spike inside A1; the real work after the screens settle.
A18                           Last, across everything.
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The design is screenshots: colors, fonts and spacing are guesses | A0 confirms them with the design owner before screens are built; a per-screen checklist in review |
| ESM `core` inside Electron's bundler and ASAR (dynamic imports, `import.meta.url`, `pdf.js`) | A1 builds an installer on day one; skills path passed explicitly; `unpdf` runs in the engine process |
| A runaway tool or large document freezes the app | The engine is a separate process (P1); output sizes are capped and diffs are fetched on demand |
| The pipeline asks questions the UI cannot show well (long options, many questions) | The gate card is built on the generic question types, with a test per kind (choice, text, confirm, defer, other) |
| A small model fills `pipeline_state` badly, so the structured panels are empty | Markdown fallback everywhere; the status tells when state and STATE.md drifted; panels say "sem resumo estruturado" instead of showing nothing |
| `run_bash` needs Git Bash on Windows; skills may need Python | Diagnostics screen (A17); the agent already reports which shell failed to the model |
| Changes made by commands are not tracked, so "Desfazer" can look incomplete | The panel says so; a git-snapshot fallback is a later option |
| Background sessions pile up approvals | A badge per session and one card at a time per session; closing a session cancels its run |
| Secrets in logs or crash reports | Logs carry no content or keys; crash reports stay local |
| Windows SmartScreen warns about an unsigned installer | Sign when a certificate exists; until then, document the warning and prefer the portable zip for internal distribution |

## 9. Open items (answers needed)

- **P1 to P7** in section 5: confirm or change each. Recommended answers are written in the table.
- **Code signing:** is there an Atlântico certificate? Without one the installer shows a SmartScreen warning.
- **Auto-update:** is there somewhere to host releases (an internal share, a GitHub release)? Until then updates are manual (P6).
- **Design assets:** the alia and Atlântico logos as SVG, and the font files (or confirmation that Inter and a given monospace are right).
- **Dark theme:** wanted soon after v1, or not at all?
- **Display name and organization:** taken from settings (the design shows "Newton / Instituto Atlântico"). Should they default from the Windows account?

## 10. Definition of done

- Every screen in section 3 works against the real `core` (no mocks in the app), with the pipeline run end to end on a sample BRD
  (PDF) plus a transcript, producing `state.json`, `STATE.md`, ADRs, specs and tasks, and the "Publicar issues" fallback.
- The security checklist (4.3) passes as automated tests, not as a manual review.
- The end-to-end suite (A16) passes against the fake model server; screenshots of each screen match the design in layout and content.
- An installer built by CI runs on a clean Windows 11 profile without admin rights, with a clean first run (settings, connection test, first chat).
- Killing the engine, closing the app mid-run, and restarting loses no saved conversation and leaves no orphaned process.
- `npm run typecheck`, the existing core suites (`test:*`) and the app's tests pass in CI; the CLI still installs without Electron.

## 11. As built

### A13: structured pipeline summaries (core)

- Three new `pipeline_state` operations, all validated and all-or-nothing like the rest: `set_architecture` (`style`, `driver`,
  `contexts` as names or `{ name, role }`, `recommendation` = `approve | approve_with_notes | request_changes`, `notes`; recording it again replaces
  it), `set_adr_alignment` (`adr`, `alignment` = `aligned | misaligned`, `note` required when misaligned) and `set_spec` (`slug`, `title`, `persona`,
  `depends_on`, `constraints`, `path`).
- `state.json` gained `architecture?`, `adrAlignment` and `specs`. The version stays 1: an older file loads with empty summaries, and a state
  without them renders exactly the same STATE.md as before (the existing golden file is unchanged). `pipeline_state get` returns them, and STATE.md
  renders "Architecture", "ADR alignment" and "Specs" sections only when there is something to show (new golden: `expected-STATE-structured.md`).
- **A spec recorded with `set_spec` starts as a `draft` review**, and a spec added after gate 3 passed reopens it. Without this, a model could pass
  G3 without ever listing a spec for review, and the "Seguir para Tarefas" button would have nothing to wait for. Editing a spec that was already
  reviewed does not undo its review.
- Not validated on purpose: that an ADR in `set_adr_alignment` is in `adrs` (it is usually an ADR that already existed in the repository) and that
  `depends_on` slugs exist yet (specs are recorded in any order). The UI should show an unknown slug as such.
- `skills/e2e-pipeline/SKILL.md` tells the model to record them when the tool is available and to rely on the markdown otherwise.

### A1: scaffold (`desktop/`)

- `desktop/` is a **separate npm package, not an npm workspace** (a small departure from P2's wording). Reason: with workspaces, a plain `npm install` at the
  root would also install Electron, which is exactly what P2 wanted to avoid. The root install and lockfile are untouched; run `npm run desktop:install` once.
  Root scripts: `desktop:dev`, `desktop:build`, `desktop:typecheck`, `desktop:smoke`.
- Layout: `src/main` (broker, `EngineHost`), `src/engine` (the utility process), `src/preload`, `src/renderer` (React), `src/shared/ipc.ts` (the one
  types-only contract). `alia-harness/core` is aliased to `../src/core/index.ts`, so the app never depends on a stale `dist/`.
- **No runtime dependencies**: `core` and its packages are bundled into `out/main/engine.js`, so the packaged app carries no `node_modules`.
- **Main and the engine are ES modules; the preload is CommonJS** (`index.cjs`), because a sandboxed preload cannot be an ES module. Bundling `core` into CommonJS
  broke `import.meta` (pdf.js), hence ESM.
- **`fflate` is aliased to its browser build** in the bundle: its Node ESM entry declares its own `require`, which collides with the one electron-vite injects. Core
  only uses the synchronous API, which the browser build has.
- **`ELECTRON_RUN_AS_NODE` is set in VS Code's terminal**, which makes the Electron binary behave as plain Node. Anything that launches Electron from a script or a
  test (A16) must delete it from the environment. The smoke script does.
- The renderer's dev config needs `dedupe` and an explicit `cacheDir`; without them the dev server loaded two copies of React.
- `npm run desktop:smoke` builds, launches the real app against a throwaway profile and checks: renderer -> preload -> main -> engine round trip; the engine
  is another process; the engine reads a PDF, a Word file and a deck and creates a session. `ALIA_SMOKE_EXE` runs the same checks against a packaged build.
  The unpacked ASAR build (`dist/win-unpacked`) passes. The NSIS installer (about 122 MB, per user) and the portable zip build.
- **Not done in A1:** the installer was built but not installed and launched on a clean Windows profile (A17 does that); there is no linter in the repository, so
  "lint" in the acceptance criteria is covered by `typecheck` for now; `npm audit` reports 6 moderate findings, all in electron-builder's build-time tooling (nothing
  in the shipped app); the default Electron icon is used (A0 brings the assets).

### A0: what was possible without the design owner

- **Logos:** the alia and Atlântico logos arrived as small PNGs (185x115 and 226x78), not SVG, so they are used as they are in `renderer/src/assets/`. They will look soft on
  high-density screens, and the alia one has its pale background baked in. Replace them when SVGs exist.
- **Fonts**, from the Atlântico site as the reference: **Inter** (interface), **Poppins** 600/700 (display headings, as the site's), and **JetBrains Mono** (code; the design
  does not name a monospace, so this is my choice and open to change). All are open-source (OFL), bundled through `@fontsource` packages, no network at run time.
- **Tokens:** `renderer/src/styles/tokens.css` holds the sampled palette from this document plus the brand navy (`#26409a`, read off the website). Still to confirm with the design
  owner: the sampled colors, and the per-screen checklist and pt-BR string list (not written).

### A2: engine, IPC contract and validation

- **Contract:** `desktop/src/shared/ipc.ts` (types only) and `schemas.ts` (zod). Every renderer request has a strict schema (unknown fields are an error) and the compiler checks each schema
  against its type. Internal requests (`ping`, `selfTest`, `engine.configure`) are not in the renderer's table, so the page cannot make them. Names that exist on every object
  (`constructor`, `__proto__`) are not requests. Ids that could name a path are refused; prompts over 200,000 characters are refused.
- **The broker** (`main/broker.ts`, no Electron imports) validates, then checks every `projectPath` against the folders the user picked through the native dialog (`projects.pick`), then forwards.
  A folder next to or inside a picked one is not covered. Main holds no conversation state.
- **The engine** (`engine/runtime.ts`, no Electron imports, tested with the fake model) owns the sessions. Created per project with `ask-commands`, the app's `skillRoots`, a `SessionStore`, and
  `onEvent`/`onConfirm`/`onAskUser`. **Project skills are not in the roots** (decision 4.3): they must wait for the trust prompt (A5). The host command `/config` is registered.
- **Runs do not hold a request open.** `session.run` replies at once (`started`, what was attached, mention errors) and the end arrives as the `run_finished` event, so no request has a long timeout
  (only `session.compact` has five minutes). `/skill input` and `@` mentions are expanded in the engine; an app command such as `/compact` is refused as a prompt (the page calls its own request).
- **Interactions:** a permission request or `ask_user` becomes an `Interaction` pushed to the page, answered with `interaction.respond` (the kind of answer must match). A cancelled run, a closed
  session or a finished run closes what is open (`interaction_closed`); `interaction.pending` lets a reloaded page show them again.
- **Events** are pushed tagged with the session id. Text fields over 32,000 characters (tool output, mainly) are cut in the event and say how much was left out; the model still saw all of it.
  Diffs are fetched on demand (`changes.diff`, capped at 400,000 characters).
- **Crash handling:** an unexpected engine exit rejects the requests in flight, pushes `engine_status: down`, starts a new engine, configures it again and pushes `restarted`. In-memory sessions
  are gone; the page reopens them with `session.open { resumeId }`. A handler exception or unhandled rejection in the engine exits the process on purpose, so main restarts it.
- **Core change, found while doing this:** a run cut off by a crash can leave tool calls without results, which the endpoint rejects on the next request. `repairInterruptedHistory`
  (core, tested in `test:store`) closes them with an "[Interrupted]" result when a conversation is resumed.
- **A race fixed on the way:** `run_finished` is emitted slightly before the run's promise settles, so a message sent right after the page showed the end could be refused as "still running".
  The conversation is freed at the event, and the older run's cleanup no longer touches a newer run.
- **Tests:** `npm run desktop:test:engine` (93 checks: sessions, tagged events, permission and question round trips, dangerous commands, cancelling with a question open, a real long command killed
  with its process tree in under two seconds, two conversations at once, changes/undo, event caps, saved conversations and resume, resume after a cut-off, models, and the broker's validation and folder rules)
  and `npm run desktop:test:app` (the same flows through the real app with Playwright for Electron and a fake OpenAI-compatible server in `scripts/lib/fakeServer.ts`: IPC validation, a real command
  approved and stopped, Desfazer, killing the engine process and carrying on, and no engine process left after quitting). The latter opens a window for a few seconds.
- **Temporary:** the engine's config comes from `ALIA_CONFIG` or the repository's `alia-config.json` with the key from `ALIA_API_KEY` or a `.env` (`main/bootConfig.ts`); A4 replaces it with settings and
  `safeStorage`. Environment switches (set by whoever launches the app, never by the page): `ALIA_DESKTOP_DATA_DIR`, `ALIA_DESKTOP_SMOKE`, `ALIA_DESKTOP_TEST` (see `main/index.ts`).
- **Not done in A2:** `pipeline.*` and `issues.*` requests (they belong to A11, A12 and A15, which define what they need); `conversations.load` returns whole messages (A9 adds the annotations and a lighter form);
  the app's bundled skills folder in a packaged build (`resources/skills`, A17).

### A3: shell and hardening

- **Served from `app://alia/`, not `file://`.** A standard, secure custom protocol (`main/appProtocol.ts`) reads the built renderer directly from disk, refuses anything that resolves outside the renderer folder
  (`..` in plain, encoded, backslash and drive-letter forms, NUL bytes) and other hosts, and sets the policy header on every response. That is what lets the `file://` fuse stay off.
- **Policy** (`securityRules.ts`): `default-src 'none'`, scripts, styles, images and fonts from `'self'` only, `connect-src 'none'` (the page cannot open a connection of its own, not even to itself: everything goes through
  `window.alia`), no frames, no objects, no inline anything, no `eval`. A session-level filter also cancels any request that is not the app's own origin, `data:`/`blob:` or (while developing) the dev server and its socket.
  In development the policy is not applied (Vite's hot reload needs inline script), so security is tested on the built app.
- **Guards on every web contents** (`guards.ts`): navigation, frame navigation and redirects are denied (even to the app's own origin: the app has no page navigation), webviews are denied, `window.open` never returns a
  window. A link the page wants opened goes through `app.openExternal`: **https only, no credentials in the address, and a native confirmation dialog showing the full address** (one at a time; a page that asks repeatedly
  gets one dialog). Camera, microphone, location, notifications and devices are denied. IPC requests are accepted only from the app's own top frame.
- **Window:** no native frame; the title bar (logo, "Harness v1.0.0", minimize, maximize/restore, close) is drawn by the app, with drag regions, names for screen readers and states pushed from main. Minimum size 960x600.
  Developer tools only while developing.
- **Menu and shortcuts:** the menu is defined (`main/menu.ts`) and its accelerators work, but with no native frame the menu bar is not drawn, so main also listens for the keys itself (`main/shortcuts.ts`, a pure
  function that is unit tested): Ctrl N new conversation, Ctrl O open project, Ctrl , settings, Ctrl J show/hide the panel. They reach the page as a `command` message; what each does on a screen is up to the screens (A5 onwards).
- **One instance:** `requestSingleInstanceLock` (keyed by the profile folder); a second copy exits and the first is focused.
- **Logs:** `<userData>/logs/main-YYYY-MM-DD.log`, kept 14 days, written through a redactor (the API key once main has read it, `Bearer` tokens, `sk-` keys, and values of `apiKey`, `password`, `token` and similar keys).
  The log records what the app does, never conversation content.
- **Fuses**, set by electron-builder: `runAsNode`, `NODE_OPTIONS` and `--inspect` off; only `app.asar` is loaded and its integrity validated; no `file://` privileges; cookies encrypted. Checked on the packaged executable.
- **Strings:** the renderer's strings now come from `renderer/src/i18n/pt-BR.ts`; main's (menu, dialogs) from `main/strings.ts`.
- **Tests:** `desktop:test:security` (unit: trust rules, request filter, link rules, protocol path resolution with hostile paths, redaction, shortcuts, main-only requests never reach the engine), `desktop:test:hardening` (the
  real app: tries to navigate, open windows, import Node, `eval`, inject scripts and styles, fetch, open sockets, embed frames, ask for the camera; checks the title-bar buttons, menu and shortcuts, the second instance, and that
  the API key is nowhere in the app data folder), `desktop:test:package` (builds the packaged app, reads the fuses, runs the smoke test on the executable).
- **Test-tooling notes:** Playwright's synthetic key presses do not reach the browser process, so the shortcut test sends the same input events from main (`webContents.sendInputEvent`); real keyboards go through the same
  `before-input-event` path. A named arrow function serialized into the page by `tsx` needs a shim the page lacks, so those tests use anonymous functions.
- **Not done in A3:** the page's markdown renderer and its link handling (A6) are what will call `app.openExternal`; IPC sender checks cover the top frame only because the app has no subframes; the NSIS installer was not
  executed on a clean profile (A17); `npm audit` still flags electron-builder's build-time tooling.

### A4: settings, config and secrets

- **Where things are** (`%APPDATA%/<app>/`): `settings.json` (endpoint, models, display name, organization, approval mode, recent projects: no secret in it) and `credentials.bin` (the API key, encrypted with Electron's
  `safeStorage`, which is DPAPI on Windows). Both are written atomically; a damaged `settings.json` is set aside as `settings.json.damaged-<time>` and the app starts from defaults instead of failing.
- **The key's path:** typed into a password field, sent to main with `settings.setApiKey`, encrypted and stored; main decrypts it only to hand it to the engine in memory (`engine.configure`) or to the engine's connection test.
  **It is write-only: no request returns it**, `settings.get` only says whether one is stored, and the field is emptied after saving. **If the OS cannot encrypt, the key is refused: there is no plain-text fallback**, and the screen says so.
  The log masks the key (main registers it with the redactor as soon as it handles it).
- **Requests** (all validated, all answered by main): `settings.get/update/setApiKey/clearApiKey/testConnection/legacyCandidate/importLegacy`, `projects.recent`; and for the engine `permissions.listForProject/removeForProject`
  (a project's allowlist without an open conversation; the folder must have been opened by the user). `settings.update` accepts only known fields; the endpoint must be http(s) without credentials; models are validated field by field
  (an unknown field such as `apiKey` inside a model is refused); two models with one id are refused before anything is saved.
- **Test connection** runs in the engine (it has the HTTP client): it lists the endpoint's models with a 10-second timeout and no retries, and answers with a reason the screen turns into plain words (`unauthorized`,
  `not_found`, `unreachable`, `timeout`, `other`); the key is stripped from any message. Models the endpoint reports can be added to the list with one click.
- **First run and import:** with nothing configured the app opens on the settings screen with a welcome note. If an `alia-config.json` is found (next to the repository, in the working folder or `~/.alia`) the screen offers to import it;
  "Importar de um arquivo…" opens a native file dialog. The import takes the endpoint (from the first model's `url`), the models and the key (environment, then a `.env` beside the file, then the file's own `apiKey`), and stores the key encrypted.
  Nothing is imported behind the user's back, except that **a launcher that sets `ALIA_CONFIG` seeds the first run** (a test and developer convenience; later changes are never overwritten).
- **The approval mode is a setting** (`ask-commands` by default; `ask-dangerous` is the CLI's; `auto` is described as "use only in folders you can lose") and applies to new conversations.
- **Recent projects are persisted** (newest first, at most 20, only folders that still exist), and hydrate the list of folders the app may open without the dialog after a restart.
- **The screen** (`SettingsScreen.tsx`, Ctrl+, or the first run): connection, models (id, name, context), profile, approval mode, and the allowlist per project (with a remove button each). It validates before saving and
  explains each problem next to its field (announced with `role=alert`); every control has an accessible name. The display name defaults from the Windows account (open item 6: editable, recommended default taken).
  A `<select>` must not be wrapped in its `<label>` (its options would become part of the name): found by the test and fixed.
- **Removed:** the temporary `bootConfig` from A2.
- **Tests:** `desktop:test:settings` (unit, 60 checks: the settings file and its damage handling, recents, the encrypted store with a fake encryptor including "no OS encryption means nothing is stored", the legacy config
  reader and its key precedence, the service end to end with a fake engine, and the broker's validation of every settings request; two rules were mutation-checked), engine tests for the connection test (right key, wrong key,
  not found, unreachable), the project allowlist and the three approval modes, and `desktop:test:settings-app` (the real app, driven like a person: first run, a wrong key and a right one, validation, saving, that the key is in no
  HTML, field, pushed message, log or plain file, that conversations use the saved settings, the allowlist screen, a restart, the approval mode, removing the key, importing).
- **Found on the way:** the OpenAI SDK's connection errors are named by class (`APIConnectionError`), not by `err.name`, so a down server was reported as "other" instead of "unreachable".
- **Not done in A4:** the settings screen is reached from a temporary home (A5 brings the sidebar and the real navigation); the per-model `toolCalling`/`vision` flags are kept from an import but not editable; "organization" and "display name"
  are only stored and shown (the greeting arrives with the home screen in A5).

### A5: projects, trust, sidebar, conversations

- **The shell now has a sidebar** (`Sidebar.tsx`): "Nova conversa" (Ctrl N), search, **Pipelines** (a project with a pipeline, with a chip), **Projetos** (recent folders, "Abrir pasta…" with Ctrl O) and **Recentes** (the
  conversations of the current project, newest first, with how long ago), and a button to the settings. The main area is the start screen (a greeting by the hour with the display name, and the current project), the open
  conversation, or the settings. The sidebar is a labelled navigation landmark and the search a search landmark; every control has a name; the row actions (rename, delete) appear when the row has focus, so Tab reaches them.
- **Opening a project:** the native dialog (`projects.pick`), after which the folder is remembered (recents, at most 20) and stays openable after a restart. The last project used is the current one at the next start.
  Switching project changes the conversation list; a conversation from another project (found by search) switches the project first.
- **Search** looks across every project (title and what the user and the assistant said, as `SessionStore.search` does), shows where each hit is, and a snippet of the text that matched.
- **Rename** is inline (Enter saves, Esc cancels, leaving the field saves); **delete** asks in an app dialog that names the conversation and puts the focus on "Cancelar" (deleting is never one keystroke away); it removes the files
  and closes the conversation if it was open.
- **Trust** (decision 4.3): a folder's own skills (`<project>/.alia/skills`) load only for a folder the user trusts. When a folder is opened and has such skills and no answer yet, a dialog lists them and asks once
  ("Confiar e carregar as skills" / "Agora não", the latter focused; Esc is "Agora não"). **The answer is remembered**, in `trust.json` in the app's data folder (never in the project, where a committed file could grant trust to
  everyone who opens it); a refusal is remembered too, so there is no nagging, and "Configurações > Pastas confiáveis" lists every project with its answer and lets the user trust or revoke. A conversation that was open when trust
  was granted is reopened so the skills load. **Main decides what the engine is told**: `session.open` is forwarded with `trustedProject` set from the trust store, and the page's request schema has no such field, so the page cannot
  claim trust. `projects.setTrust` is a request from the page (the dialog is the app's own); a native confirmation was considered, and the in-app dialog chosen because it can list the skills; the trade-off is that a compromised page
  could grant trust for a folder the user opened (the CSP, the sanitized markdown planned for A6 and the folder rule are the defenses).
- **Running and waiting marks (P5):** a spinner beside a conversation while it runs, an **orange dot** while it waits for an approval or a question, and the same marks on the project when something in it is running or waiting
  (so a run in another project is visible). They come from the pushed events, reconciled with the engine's own list (`sessions.active`) after a reload or restart. A request from a background conversation shows the dot and
  nothing else: no focus change, no screen change (tested). Answering the card is A8.
- **Pipelines:** `pipeline.brief` reads a project's `state.json` through `getPipelineStatus` and gives the sidebar a chip: `G1 · 3/5` (waiting at a gate), `G1 · aprovar`, `G3 · revisão`, `Etapa 2`, `Concluído`, or a warning
  (`Entradas mudaram`, `Estado inválido`). It refreshes on window focus and when a run starts or ends. It is per **project**, since the pipeline runs in one conversation per project; clicking the chip opens the project.
- **Core of the UI logic is pure and tested** (`lib/`): greeting, "há 5 min / ontem", the running/waiting reducer (a subagent's events do not start or end the conversation's run; the engine going down forgets everything),
  the chip, project names (both path separators).
- **Found on the way:** the broker applied the "folder was opened by the user" rule only to requests it forwarded to the engine, not to the ones main answers itself; with the new `projects.inspect`/`projects.setTrust`
  that would have let the page inspect or grant trust for any path. The rule now runs first, for everything (mutation-checked).
- **Tests:** `desktop:test:projects` (trust store, project skills, and the broker's rules; 22 checks), `desktop:test:ui-logic` (pure logic; 27 checks), engine tests for project skills, active sessions and the pipeline brief,
  and `desktop:test:sidebar-app`, the real app driven like a person: the greeting, opening folders, the list, search, opening, rename, delete, keyboard, the trust question and its three outcomes, running and waiting marks across
  projects, the pipeline chip, Ctrl N, and a restart.
- **Not done in A5:** the open conversation is a plain reading view (what was said and answered; the timeline is A6, the composer A7, the approval card A8); there is no keyboard shortcut for rename or delete (the buttons are
  reachable with Tab); the conversation list has no pagination (it is capped by `conversations.list`'s own limit); a project's pipeline is a chip only (the wizard is A11-A15).

### A6: chat timeline

- **The timeline is data first** (`lib/timeline.ts`, pure): a reducer turns the engine's events into rows, and `rowsFromMessages` turns a saved conversation into the same rows, so a live run and a reopened conversation look alike.
  Rows: the user's message, the assistant's text (the text a model writes beside tool calls is shown muted, the final answer is marked), reasoning (collapsed), tool calls, and notices.
- **Rows as the design shows them** (`Timeline.tsx`): consecutive `read_file` calls are one row, "Leu 2 arquivos" (open it for the paths); a written file is "Gravou out/novo.md +2 −0", an edit "Editou a.txt +2 −1" (counts come from the
  `changes` summary, with no file content); a command is "Executou <command>" with **passou / falhou (código N) / cancelado / tempo esgotado / negado**, read from the result's exit code, and its output behind the row (a button with
  `aria-expanded`, so Enter opens it); `use_skill` is "Usou a skill <name>"; each call shows its duration. **A `run_subagent` call is one row with the child's tool calls nested under it**, its label and how it ended; the child's own chatter is not shown.
- **Spinner while the model thinks** ("Pensando…", from `model_started`/`model_finished`), errors as one red row announced to screen readers (core's notice and the run's end say the same thing; it is shown once), "Execução cancelada.", compaction
  (with tokens before and after) and the step cap. The timeline is a labelled live `log` region, and it follows the end of the conversation unless the user has scrolled up to read.
- **Markdown is sanitized** (`Markdown.tsx`, react-markdown with GFM): raw HTML is never HTML (a `<script>`, `<img onerror>` or `<iframe>` in an answer shows as text and nothing runs); **a link is a link only if it is https**, and clicking it asks main
  (`app.openExternal`, which shows the native confirmation with the full address); http, `javascript:` and `file:` links are plain text with a tooltip saying why; images are never loaded (the description is shown).
- **The header:** the model chip (click to list the configured models and switch; disabled while a run is going) and the **context meter** (`role=meter`, percent, and "N de M tokens" on hover; it follows the conversation and the model's window).
- **New push `user_message`**: the engine says what the user wrote when a run starts, whoever started it (the composer, another window, a test), so the user's row is always there.
- **Opening a conversation mid-run:** a call that has no result yet is shown as running (live events finish it), not as cancelled; found by the end-to-end test.
- **Tests:** `desktop:test:timeline` (58 checks, on event sequences **recorded from the real engine runtime** with the fake model, real tools and real commands: a plain answer, reads/list/write/edit, a command that passed, failed and timed out, a refused one, one stopped
  mid-run, a skill, a subagent, an API error; plus hand-made events for the cases the fake cannot produce: thinking pieces, duplicates, mid-run pages, the step cap, compaction, non-JSON arguments; and that the same conversation reopened from disk gives the same rows)
  and `desktop:test:timeline-app` (38 checks in the real app: a conversation reopened, a run followed live with spinner and counts, hostile markdown, Stop, an API error, the model chip and the meter, no leaking between conversations, keyboard and a11y; run 3 times for flakiness).
- **Not done in A6:** the diff behind an edit row is the Changes panel (A10); a reopened conversation has no durations or +/− counts (A9 stores annotations); the timeline is not virtualized (A18); there is no syntax highlighting in code blocks;
  the Stop button and composer that drive all this from the UI are A7 (the tests start runs through the engine API).
