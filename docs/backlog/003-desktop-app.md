# Backlog 003: Desktop app (Electron)

| | |
|---|---|
| **Status** | In progress. Done: A13 (structured summaries in `core`; `npm run test:pipeline`), A1 (scaffold; `npm run desktop:smoke`), A2 (engine, IPC contract and validation; `desktop:test:engine`, `desktop:test:app`) and the part of A0 that did not need the design owner (logos, fonts, tokens). Proposals P1-P7 are being followed as recommended until someone says otherwise. Next: A3 (shell and hardening), then A4/A5. A0 still needs the color and string-list sign-off. See section 11 for what was built and where it departs from this document. |
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
| A3 | Shell and hardening | 5 | Custom title bar and window controls as in the design; single-instance lock; app menu and shortcuts (Ctrl N); everything in 4.3 verified by a test that tries to navigate, open a window, and call Node from the renderer and fails; logs with no secrets |
| A4 | Settings, config and secrets | 5 | The `/config` screen: endpoint URL, models (id, name, context size), display name, organization, default permission mode; API key stored with `safeStorage` and never sent to the renderer; "test connection" lists the endpoint's models; first-run import from an existing `alia-config.json` / `.env`; the allowlist per project can be listed and removed (`session.permissions`) |
| A5 | Projects, trust, sidebar, conversations | 5 | Open folder, recent projects, switching projects; a one-time "trust this folder?" before project skills load; conversations list from `SessionStore` (newest first, by project), search, rename, delete; Ctrl N; the greeting by time of day with the display name; pipeline sessions listed with their gate chip from `getPipelineStatus`; per P5 the sidebar shows running and waiting states |
| A6 | Chat timeline | 8 | Events become rows: "Leu N arquivos" (consecutive reads grouped), "Editou/Gravou path +a -r" from `changes`, "Executou cmd" with a collapsible output and passou/falhou from the exit code, `use_skill` and `run_subagent` as nested rows, final answers as markdown; a spinner while `model_started` is open; errors and "Run cancelled" shown; markdown sanitized (no raw HTML, links confirmed); the model chip and context meter (`getContextUsage`); unit tests for the event-to-row mapper with recorded event sequences |
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
