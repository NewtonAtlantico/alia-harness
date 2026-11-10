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
   - **Safety Gate**: Interactively warns the user and requires approval before executing potentially destructive commands (`rm -rf`, `del /s`, `git reset --hard`, `DROP DATABASE`, etc.).

3. **Context & Token Window Management**
   - **Output Truncation**: Caps massive outputs (preserving the head and tail) so build logs and long file dumps do not blow up the context window.
   - **Compaction / Pruning**: Automatically prunes stale tool outputs when approaching `maxInputTokens` limits while preserving the system prompt and recent turns.

4. **Terminal User Interface (TUI)**
   - Colorized feedback using `picocolors`.
   - Clear distinction between model thinking/reasoning, tool calls with arguments, tool execution output, and final agent response.
   - Built-in REPL with slash commands.

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
npx tsx src/index.ts
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
- `/models` — List configured models and live endpoint models.
- `/model <id>` — Switch active model dynamically.
- `/tokens` — Check current estimated token count and context usage.
- `/clear` — Reset conversation history.
- `/exit` or `/quit` — Exit the harness.
