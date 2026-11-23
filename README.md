# Alia CLI Harness

A TypeScript CLI harness and autonomous AI agent loop designed for custom OpenAI-compatible Alia LLM endpoints (e.g. `alia-quiver`, `gpt-oss:20b`, `qwen3.6`, etc.).

---

## Architecture Overview

```
                      ┌──────────────────────┐
                      │   User Prompt / CLI  │
                      └──────────┬───────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │    Context Manager      │  ◄── Output Truncation &
                    │  (Messages + History)   │      Token Window Compaction
                    └────────────┬────────────┘
                                 │
                                 ▼
                    ┌─────────────────────────┐
                    │   OpenAI Client (Alia)  │  ◄── Custom Base URL &
                    │   chat.completions      │      API Key Config
                    └────────────┬────────────┘
                                 │
                     ┌───────────┴───────────┐
                     │                       │
           [Tool Calls Requested]      [Text Output]
                     │                       │
                     ▼                       ▼
          ┌─────────────────────┐   ┌─────────────────┐
          │   Safety Checker    │   │  Terminal UI    │
          │ (Human-in-the-Loop) │   │ (Render Result) │
          └──────────┬──────────┘   └─────────────────┘
                     │ Approved
                     ▼
          ┌─────────────────────┐
          │    Tool Execution   │
          │ • read_file         │
          │ • run_bash          │
          │ • write_file        │
          │ • list_files        │
          └──────────┬──────────┘
                     │ Feedback (role: tool)
                     └──────────► (Repeat While Loop)
```

### Folder layout

```
src/
├── core/   UI-agnostic engine (agent loop, tools, skills, safety, context, client, config).
│           Public entry: `alia-harness/core`. Must never import from a UI folder.
└── cli/    Terminal experience (arg parsing, REPL, slash commands, prompt, banner, spinner).
            Entry point of the `alia-agent` binary.
```

Other front-ends (VS Code extension, standalone app) become sibling folders of `cli/` that depend only on
`core/`. A front-end creates one `createSession({ workspace, config, ... })` per conversation (`core/session.ts`) and
renders the typed `AgentEvent` stream it emits (`onEvent`). Everything else a UI needs is on the session: cancellation
(`run(prompt, { signal })`), approvals (`onConfirm`, with an allowlist per project), saved conversations (`sessionStore`,
`resume`), the slash-command list (`commands`), `/compact`, file changes with diff and undo (`changes`), structured
questions (`onAskUser`), reading PDF / Word / PowerPoint documents, and the requirements-to-tasks pipeline state
(`pipelineStatus()`, `resumePipelinePrompt()`) and issue-publishing check (`issuePublishing()`).
Design and behavior of each piece: [docs/backlog/002-desktop-prereqs.md](docs/backlog/002-desktop-prereqs.md).
`npm run test:e2e` runs them together as one story; the per-feature suites are the `test:*` scripts in `package.json`.

---

## Key Features

1. **The Core Agent Loop (The Master While Loop)**
   - **Input**: User prompt + message history with system instructions.
   - **Reason**: The model analyzes the request, reasons (capturing `reasoning_content`), and returns either a text response or tool calls.
   - **Act**: Harness intercepts tool calls and executes them locally in the current workspace.
   - **Feedback**: The tool output is appended as a `tool` role message and fed back into the model until the task is complete.

2. **Constrained Tool Sandbox & Safety Gate**
   - `read_file`: Reads text files with line range and line numbering support; binary files are rejected (detected by extension or NUL bytes) instead of polluting the context window.
   - `run_bash`: Runs shell commands with configurable timeout and stderr capture. Prefers a POSIX bash shell (Git Bash on Windows) so `&&`, pipes, and POSIX syntax work on every platform; falls back to PowerShell and reports the active shell when a command fails.
   - `write_file`: Creates or overwrites files, automatically making parent directories.
   - `edit_file`: Surgically replaces exact target strings; rejects ambiguous targets that match more than once (unless `replace_all`), and supports multiple atomic edits in one call via an `edits` array (all-or-nothing).
   - `list_files`: Explores directory trees with depth limits, ignoring noise (`node_modules`, `.git`, etc.).
   - `grep_search`: Fast text and regex search across files in the workspace, skipping binary files.
   - `use_skill`: Loads a skill's full instructions on demand (see [Skills](#skills)).
   - **Safety Gate**: Interactively warns the user and requires approval before executing potentially destructive commands (`rm -rf`, `del /s`, `git reset --hard`, `DROP DATABASE`, etc.).

3. **Context & Token Window Management**
   - **Output Truncation**: Caps massive outputs (preserving the head and tail) so build logs and long file dumps do not blow up the context window.
   - **Compaction / Pruning**: Automatically prunes stale tool outputs when approaching `maxInputTokens` limits while preserving the system prompt and recent turns.

4. **Terminal User Interface (TUI)**
   - Colorized feedback using `picocolors`.
   - Clear distinction between model thinking/reasoning, tool calls with arguments, tool execution output, and final agent response.
   - Built-in REPL with slash commands and `@` file mentions (Claude Code-style).

---

## Configuration & Security

API credentials are kept strictly out of version control by loading from `.env`:

### 1. Set Your API Key in `.env`

Copy `.env.example` to `.env` and configure your key:

```bash
# .env (git-ignored)
ALIA_API_KEY=sk-your-actual-api-key
```

### 2. Model & Endpoint Configuration ([`alia-config.json`](file:///c:/Projetos/alia-harness/alia-config.json))

The JSON file contains the provider metadata and model endpoints without secrets:

```json
{
  "name": "alia-quiver",
  "vendor": "customendpoint",
  "apiKey": "",
  "apiType": "chat-completions",
  "models": [
    {
      "id": "gpt-oss:20b",
      "name": "gpt-oss",
      "url": "https://chat.alia.atlantico.com.br/api/",
      "toolCalling": true,
      "vision": true,
      "maxInputTokens": 128000,
      "maxOutputTokens": 16000
    }
  ]
}
```

---

## Quickstart

### 1. Install Dependencies & Build

```bash
npm install
npm run build
```

### 2. Run Interactive REPL

```bash
npm start
# or:
npx tsx src/cli/index.ts
```

### 3. Run Single Prompt (Non-Interactive / Scripting)

```bash
npm start -- -p "Inspect the package.json and tell me what dependencies are installed"
```

### 4. Command Line Options

```
OPTIONS:
  -p, --prompt <string>    Execute a single prompt and exit (non-interactive mode)
  -m, --model <name>       Choose model id (default: from alia-config.json)
  -c, --config <path>      Path to custom configuration file
  --auto-approve           Auto-approve potentially destructive commands (skip safety prompt)
  -h, --help               Display help message
```

### 5. Interactive REPL Slash Commands (Dynamic Preview on `/`)

As soon as you type `/`, a dynamic preview menu appears directly beneath your cursor and filters in real-time as you type:
- **`Tab`**: Autocomplete the matching command.
- **`↑ / ↓`**: Navigate and highlight commands in the menu.
- **`Enter`**: Select and execute the highlighted command.
- **`Backspace`**: Delete characters; deleting `/` automatically closes the preview.

Available slash commands:
- `/help` — Display help and command list.
- `/tools` — Inspect all registered tools and their schemas.
- `/skills` — List skills and whether each is available.
- `/<skill-name> [input]` — Run a skill directly (every available skill appears in the `/` menu).
- `/models` — List configured models and live endpoint models.
- `/model <id>` — Switch active model dynamically.
- `/tokens` — Check current estimated token count and context usage.
- `/clear` — Reset conversation history.
- `/exit` or `/quit` — Exit the harness.

---

### 6. File Mentions — Attach Files with `@` (Dynamic Preview)

Just like Claude Code: type `@` anywhere in your prompt and a live preview of workspace
files appears beneath your cursor, filtering as you type.

- **`@`** — opens the file preview (workspace files and directories, ranked by relevance:
  exact match > basename > path prefix > substring > fuzzy subsequence).
- **`Tab`** — inserts the highlighted file into the prompt as `@path/to/file`.
  Inserting a directory (`@src/core/tools/`) keeps the preview open so you can drill down.
- **`↑ / ↓`** — navigate the preview; **`Enter`** confirms the highlighted file.
  Without navigation, `Enter` submits the prompt as usual.
- **`Esc`** — dismisses the preview until you edit the mention again.

On submit, every `@path` mention is resolved and the file's current contents are
attached to the message sent to the model (directories attach a listing of their
entries). Mentioned files are shown with a `📎 Attached:` summary, and the agent can
work with them without spending tool calls on `read_file` first.

```text
user > review @src/cli/ui/prompt.ts and @src/core/tools/editFile.ts for bugs
📎 Attached: @src/cli/ui/prompt.ts (625 lines), @src/core/tools/editFile.ts (143 lines)
```

Details and guardrails:

- Mentions only trigger at the start of a word, so emails like `user@host` are ignored.
- `node_modules`, `.git`, binary files, and symlinks are excluded from the preview.
- Large files are attached with head+tail truncation (100 KB per file, 300 KB total
  per prompt); binary files are rejected with a warning instead of dumped as garbage.
- `@mentions` also work in non-interactive mode: `npm start -- -p "Summarize @README.md"`.
- Mention resolution is covered by `npm run test:mentions`.

---

## Skills

Skills are reusable playbooks: a folder with a `SKILL.md` (YAML frontmatter with `name` and
`description`, then markdown instructions) and optional `references/`, `scripts/` and `assets/`.
The harness loads them with progressive disclosure, so 19 skills cost about 1.5k tokens of context
instead of tens of thousands:

1. **Catalog** — only `name: description` for each available skill is added to the system prompt.
2. **On demand** — the model calls `use_skill("<name>")`, or you run `/<name> [input]`, and the full
   `SKILL.md` is loaded into the conversation (wrapped in a `<skill ...>` block).
3. **Lazily** — supporting files (`references/…`, `scripts/…`) are read with `read_file` /
   `run_bash` only when a step needs them.

```text
user > /spec-to-tasks @docs/specs/login.md
ℹ Skill loaded: spec-to-tasks
user > write a spec for the export feature      # the model may call use_skill("spec-driven-development") itself
```

**Where skills are found** (later wins on a name clash): the bundled `./skills` folder next to the
harness, `~/.alia/skills`, `<cwd>/.alia/skills`, then any folders in `ALIA_SKILLS_DIR`
(path-delimited). Only direct children of a root are scanned.

**Harness adaptations** applied when a skill is loaded:

- A short note maps Claude Code concepts onto the harness (the `Skill` tool is `use_skill`; there is
  no `AskUserQuestion`, subagent or MCP tool, so ask plain-text questions and wait).
- `.claude/skills/<name>/…` paths inside a skill are rewritten to the real folder, so bundled
  scripts such as `embrapii-docs/scripts/build_docx.py` resolve.
- Loaded skills are **never pruned** by context compaction, and are not subject to the 16k-char
  tool-output cap.

**Gating with `requires:`** — a skill may list tools it needs in its frontmatter:

```yaml
requires: createJiraIssue, searchJiraIssuesUsingJql
```

If no registered tool matches (exactly, or as an MCP-prefixed `mcp__server__<name>`), the skill is
left out of the catalog and the `/` menu, and `/skills` shows why. Today this hides
`add-tasks-to-jira` and `playwright-mcp-verification`, which need an MCP client the harness does not
have yet.

Run `npm run test:skills` to check loading, gating, path rewriting and pruning behavior.

**Roadmap:** running each stage of `requirements-to-tasks-pipeline` in an isolated subagent is
planned in [docs/backlog/001-subagents.md](docs/backlog/001-subagents.md).

### Flows

A **flow** says which skills and which steps the end-to-end pipeline (`requirements-to-tasks-pipeline`)
runs for a kind of project: the skill of each of the four stages and where its artifact goes, which
skill reads each kind of input (a document, a thread or transcript, a short request), and how each
step is called, both for people who read the code ("Requisitos") and for people who do not ("Entender
o pedido"). The pipeline itself (the state file, the gates, the review of the specs) is the same for
every flow. A flow lives in one entry of `FLOWS` in
[`src/core/pipeline/flows.ts`](src/core/pipeline/flows.ts); the intake, the run, the resume and both
screens of the desktop app follow from it.

Today there is one flow, `embrapii`, which is the pipeline as it has always run. The flow of a project is
recorded in `docs/pipeline/state.json` (`"flow": "embrapii"`; a state written before flows existed runs
the default flow) and cannot change once a stage has started. The pipeline skill is told which flow it
runs, and the stages with their skills, in the text that starts or resumes it. Run `npm run test:flows`.

## Desktop app: two views

The desktop app ([`desktop/`](desktop)) has two views of the same projects, switched with **Simples | Técnico**
(the title bar in the technical view, the top of the page in the simple one; the choice is remembered).

- **Técnico** — conversations, the pipeline's stages, gates, files and the `STATE.md`. A new pipeline
  starts by choosing its **Fluxo** in a list, then the project and the files.
- **Simples** — for people who are not technical. A project is made from a name, what the person wants
  built and the files they already have (the app makes the project's folder under `Documents\alia`);
  the **Cliente** is the flow. The four steps are shown in plain words, and the person only does what is
  theirs: answers the questions one at a time (the files that disagree side by side; "Não sei" goes to
  the technical owner, "Decidir depois" stays with them), confirms each feature ("Está certo" / "Algo está
  errado"), and sends the finished plan to the technical team (published as issues, or drafts when there is
  no connection to the team's system) or takes it away as a PDF or a link. The architecture is the
  technical owner's to decide, in the technical view. What the simple view keeps about a project (its
  name, the request, the technical owner, whether the plan was handed over) is in `<project>/.alia/project.json`.

Run `npm --prefix desktop run test:simple-logic` and `npm --prefix desktop run test:simple-app`.
