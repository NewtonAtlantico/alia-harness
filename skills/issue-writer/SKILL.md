---
name: issue-writer
description: Create context-rich GitHub/GitLab issues that provide enough information for AI agents to implement independently — extracts technical context from the codebase, pre-fills the template, and publishes via CLI, MCP, or file fallback
---

# Issue Writer

Create a context-rich issue that an AI agent can implement independently, without needing to ask follow-up questions. The agent fills in everything it can infer from the codebase and only asks the human for what it genuinely cannot deduce.

If the source material is a full spec rather than a single scoped ask, run `spec-to-tasks` first to break it into atomic, estimated tasks — then create one issue per task instead of one oversized issue per spec.

## Core Principle

**Be assertive, not interrogative.** Extract context first, then present a complete pre-filled draft for human review. Never ask field-by-field — show a full draft and let the human edit what needs adjusting.

## Phase 1 — Intent

Collect from the human (or infer from branch name, recent commit, open TODOs):

- **Issue type:** bug / feature / task / chore
- **Provisional title**
- **Motivation in one sentence**

If any of these can be inferred (e.g., branch `fix/login-timeout` → bug, title "Fix login timeout"), suggest them and ask for confirmation instead of asking from scratch.

## Phase 2 — Context Extraction

Run these steps before drafting. Do not skip — this is what makes the issue useful to an agent.

1. **Detect provider**
   ```
   git remote get-url origin
   ```
   - Contains `github.com` → use `gh` / `mcp__github`
   - Contains `gitlab.com` → use `glab` / `mcp__gitlab`
   - Neither / multiple → ask the human to confirm provider

2. **Understand codebase**
   - `git log --oneline -20` — recent context and patterns
   - Top-level directory structure — understand project layout
   - Primary languages and frameworks in use

3. **Find relevant files**
   - Grep for keywords from the title/topic
   - Look for the most directly affected modules, functions, classes

4. **Describe current behavior**
   - Read the relevant files found above
   - Describe what the code does today, factually

5. **Map dependencies and impacts**
   - Identify imports, external calls, shared services used by affected modules
   - `git log --all --grep="<topic>"` — find prior related commits or issues

6. **Infer labels**
   - List existing labels: `gh label list` / `glab label list`
   - Select the most relevant ones — do not create new labels

7. **Estimate size**
   - XS: 1 file, trivial change
   - S: 2–4 files, clear scope
   - M: 5–10 files or moderate complexity
   - L: many files, unclear scope, or significant risk

## Phase 3 — Draft and Preview

Generate the complete issue using the template below. Present it in full — do not ask field-by-field. The human reads and edits what needs adjusting.

Only ask a question if a required field (`*`) cannot be inferred at all.

### Issue Template

```markdown
## Context and Motivation *
<Why does this issue exist? What problem does it solve?>

## Type *
[ ] Bug  [ ] Feature  [ ] Task  [ ] Chore

## Current Behavior / Current Situation *
<What happens today? What is the state of the code before this change?>

## Expected Behavior / Desired Outcome *
<What should happen after implementation?>

## Acceptance Criteria *
- [ ] <verifiable criterion 1>
- [ ] <verifiable criterion 2>

## Out of Scope *
<What is deliberately excluded to keep this issue focused?>

## Relevant Files and Modules
<Paths, functions, classes the agent should read before starting>

## Dependencies and Impacts
<Related issues, affected services, regression risks>

## Technical Approach Suggestion
<Implementation direction without over-prescribing — optional but encouraged>

## Estimated Size
[ ] XS (< 1h)  [ ] S (1-4h)  [ ] M (4-8h)  [ ] L (> 1 day)

## Labels
<Existing repo labels only>
```

**Agent fills:** current behavior, relevant files, dependencies, labels, estimated size, technical approach suggestion.

**Human confirms/adjusts:** acceptance criteria, out-of-scope definition — pre-populated with agent suggestions, edited rather than invented from scratch.

## Phase 4 — Validation

Before publishing, verify:

- All `*` fields are non-empty
- No field contains: `TODO`, `TBD`, `<placeholder>`, raw angle-bracket tokens (`<text>`), or unchanged template prose
- Provider detected correctly

If validation fails, list exactly which fields need attention. Do not publish.

## Phase 5 — Publication

Attempt in this order:

### 1. CLI (preferred)

GitHub:
```bash
gh issue create --title "<title>" --body "<body>" --label "<label1>" --label "<label2>"
```

GitLab:
```bash
glab issue create --title "<title>" --description "<body>"
```

Verify auth first: `gh auth status` / `glab auth status`

On auth failure: instruct the human to run `gh auth login` / `glab auth login`, then retry.

### 2. MCP (when CLI unavailable)

- GitHub: use `mcp__github` tools to create the issue
- GitLab: use `mcp__gitlab` tools to create the issue

### 3. File fallback (when neither CLI nor MCP available)

Save to: `docs/issues/<YYYY-MM-DD>-<slug>.md`

Where `<slug>` is the issue title in kebab-case, max 50 chars.

Create `docs/issues/` if it does not exist. Inform the human of the saved path and instruct them to publish manually.

### After successful publication

Return the issue URL. No further action needed.

## Error Reference

| Situation | Action |
|-----------|--------|
| CLI not installed | Fall back to MCP silently |
| MCP not available | Fall back to file draft |
| Required field empty or generic | List missing fields, do not publish |
| API error | Save draft to `docs/issues/`, report error with details |
| No git remote detected | Ask human to specify provider |
| `docs/issues/` does not exist | Create it before saving |

## What NOT to do

- Do not create labels that don't exist in the repo
- Do not split one issue into multiple automatically
- Do not use `.github/ISSUE_TEMPLATE/` files — this skill uses its own template
- Do not ask field-by-field questions when you can infer and present a full draft
