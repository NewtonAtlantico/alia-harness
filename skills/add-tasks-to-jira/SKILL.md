---
name: add-tasks-to-jira
description: Publishes a spec-to-tasks task file to the project's Jira board — creating (or reusing) one Jira Story per source spec and one Jira Task per generated task, carrying over slice, story points, description, acceptance criteria, out-of-scope, and dependency links. Use after spec-to-tasks has produced a reviewed task file and the tasks are ready to be tracked in Jira, instead of hand-copying them into issues.
requires: createJiraIssue, searchJiraIssuesUsingJql
---

# Add Tasks to Jira

Takes the atomic tasks `spec-to-tasks` produces (in `docs/tasks/*.md`) and publishes them to this
repo's Jira project as real, linked issues — one Jira **Story** per source spec/story, one Jira
**Task** per generated task, wired to that Story as its parent, carrying every field the task file
recorded, and linked to each other along the task file's own `Depends on` relationships.

This is the Jira-specific sibling of `issue-writer` (which targets GitHub/GitLab). Use this skill
instead of `issue-writer` when the destination is this project's Jira, not a git-forge issue
tracker.

## Target saved by the app (read this first)

Before anything else, read `docs/tasks/.jira-target.json` (`read_file`). The desktop app writes it when the
person connects Jira and chooses a project: `{ "serverId", "projectKey", "projectName"?, "site"? }`.

- **If it exists, it replaces the fixed table below.** Wherever this skill says project `MPT`, use its
  `projectKey`. Resolve the rest live, never from the table: the cloud id from
  `getAccessibleAtlassianResources` (pick the site that matches `site`; if there is only one, use it); the
  issue type ids for the story-like type (História / Story) and the task type (Tarefa / Task) and the Story
  Points field from `listJiraProjectIssueTypesMetadata` and `getJiraIssueTypeMetaWithFields` for that project.
  The board link in the final report becomes the project's own page on that site.
- **If it does not exist**, use the fixed table below, as before.
- Never delete issues, and only edit the issues this skill itself created (the ones recorded in the sync file).

## Default Jira board (fixed — edit here to repoint)

This skill always publishes to the same board. There is no per-run prompt for project/board;
change these constants (and re-save the skill) if the team ever moves boards.

| Setting | Value |
|---|---|
| Site | `institutoatlantico.atlassian.net` |
| Cloud ID | `14ae4080-82d0-48f4-a807-81932f972fc5` |
| Project | MPT Digitalização (key **MPT**, id `10140`) |
| Board | "MPT board" (id `178`) |
| Story issue type | História — id `10001` |
| Task issue type | Tarefa — id `10002` |
| Story Points field | `customfield_10026` |
| Parent-link field (Task → Story) | `parent` |
| Dependency link type | `Blocks` (id `10000`) — outward `blocks` / inward `is blocked by` |

If `listJiraProjectIssueTypesMetadata` / `getJiraIssueTypeMetaWithFields` for project `MPT` ever
returns different IDs than the table above (a field got reconfigured), trust the live call and
update this table to match — don't silently use stale IDs.

## When to invoke

- A `spec-to-tasks` task file exists under `docs/tasks/` (or an equivalent reviewed, atomic task
  list) and the human wants it tracked in Jira
- Re-running against a task file that was already partially or fully published, to pick up new or
  edited tasks without duplicating what's already there
- **Not** for a task list that hasn't been through `spec-to-tasks`'s validation (no story points,
  no acceptance criteria, un-split >8-point items) — send it back through that skill first
- **Not** for GitHub/GitLab — that's `issue-writer`

## Inputs

- One or more task files from `docs/tasks/` (e.g. `docs/tasks/02-equipment-registry-tasks.md`),
  or "all of them" per `docs/tasks/INDEX.md`
- The task file's own header (source spec link, story title) and every `### T<slice>.<n>` block
  in it: title, Slice, Story points, Depends on, Description, Acceptance criteria, Out of scope

## Process

1. **Read the task file and its source spec.** From the task file header, get the story number
   and title (e.g. "Story 2: Manage Equipment Registry (Finder-Enriched)") and the source spec
   path. Parse every `### T<slice>.<n>` block into its fields.

2. **Load or create the sync record.** Read `docs/tasks/.jira-sync.json` if it exists (create it,
   `{}`, if not). It maps each task file to the Jira keys already published for it:
   ```json
   {
     "02-equipment-registry-tasks.md": {
       "story": "MPT-1234",
       "tasks": { "T1.1": "MPT-1235", "T1.2": "MPT-1236" }
     }
   }
   ```
   This is the source of truth for idempotency — always prefer it over re-searching Jira by text.

3. **Resolve the Story issue.** If the sync record already has a `story` key for this file, reuse
   it (confirm it still resolves via `getJiraIssue`; if it was deleted, fall through to create).
   Otherwise:
   - Search first: `searchJiraIssuesUsingJql` with
     `project = MPT AND issuetype = "História" AND summary ~ "<story title>"` — reuse an exact
     match rather than creating a duplicate.
   - If none found, create one with `createJiraIssue`: project `MPT`, issue type `10001`,
     `summary` = the story title (without the "Story N:" prefix — Jira doesn't need it),
     `description` built from the spec's Persona, Traces to, and a link back to the spec file
     path (as plain text — Jira Cloud has no access to the repo, so this is a breadcrumb for
     humans, not a clickable link unless the repo is otherwise hosted).
   - Record the resulting key in the sync record.

4. **Resolve each Task issue**, in the task file's order. For each `T<slice>.<n>`:
   - If the sync record already maps this task ID to a key, **update** that issue
     (`editJiraIssue`) instead of creating a new one — this is what makes re-runs safe after the
     task file is edited. Update `summary`, `description`, and the Story Points field to match
     the current file content.
   - Otherwise create it (`createJiraIssue`): project `MPT`, issue type `10002` (Tarefa),
     `parent` = the Story's key from step 3, `customfield_10026` = the task's story points,
     `labels` = [`slice-<n>`], and `summary`/`description` per the field mapping below. Record
     the new key in the sync record immediately after creation — don't batch this to the end,
     so a mid-run failure still leaves earlier tasks tracked and safe to resume.

5. **Link dependencies.** After every task in the file has a Jira key, walk each task's
   `Depends on` field again. For each dependency that is a task ID *within this same file*
   (e.g. `T1.2` depends on `T1.1`), create a `Blocks` link
   (`createJiraIssueLink`) with T1.1 as the blocker (`outwardIssue`) and T1.2 as the blocked
   issue (`inwardIssue`) — i.e. T1.1 "blocks" T1.2. Skip a dependency pair if that exact link
   already exists (check `issuelinks` on the issue, e.g. via `getJiraIssue`, before creating).

6. **Handle cross-story dependencies stated in prose** (e.g. "sits behind Story 1's RBAC
   boundary") — these have no task ID to link to. Do not invent a link target; instead make sure
   the prose survives into the Jira Task's description verbatim (see field mapping) so a human
   reading the issue still sees the constraint.

7. **Save the sync record** (`docs/tasks/.jira-sync.json`) after every create/update, not only at
   the end — treat it as a durable log, not a final report.

8. **Report back**: the Story's key + URL, a table of every Task's key + URL + points, and how
   many were newly created vs. updated on this run. Point to the board:
   `https://institutoatlantico.atlassian.net/jira/software/projects/MPT/boards/178`.

## Field mapping (task file → Jira Task)

| Task file field | Jira field | Notes |
|---|---|---|
| `### T1.2 — Equipment CRUD API` (title, ID stripped) | `summary` | Keep the task ID as a prefix in the summary too (`T1.2 — Equipment CRUD API`) — it's the only place the file's own ID survives once triaged into Jira's own key space, and it's what a human uses to cross-reference back to the `.md` source. |
| **Description** paragraph | `description`, under a `Description` heading | Restate, don't reword — same as `issue-writer`'s principle. |
| **Acceptance criteria** checklist | `description`, under an `Acceptance Criteria` heading | Keep as a literal Markdown checklist (`- [ ]`) — Jira renders GFM task lists. |
| **Out of scope** | `description`, under an `Out of Scope` heading | Omit the heading only if the task file says "None." |
| **Slice** | `labels` (`slice-<n>`) *and* stated in the description | Both — labels make it filterable on the board, the description keeps it human-readable. |
| **Story points** | `customfield_10026` | Numeric, Fibonacci value straight from the file — never recompute it. |
| **Depends on** (same-file task IDs) | `Blocks` issue link | See step 5. |
| **Depends on** (prose / other story) | `description`, under a `Cross-story dependency` heading | See step 6. |
| Source file + task ID | `description`, under a `Source` heading | e.g. `docs/tasks/02-equipment-registry-tasks.md#T1.2` — this line is also what makes a task re-identifiable if `.jira-sync.json` is ever lost. |
| Story (parent story/spec) | `parent` | Set on create; Jira does not let you change issue-type-defined hierarchy casually after the fact, so get this right on create. |

## Sync record format

`docs/tasks/.jira-sync.json`, one entry per task file:

```json
{
  "<task-file-name>": {
    "story": "<Jira key of the História>",
    "tasks": { "<task ID>": "<Jira key of the Tarefa>", "...": "..." }
  }
}
```

Commit this file alongside the task files — it's what lets a second run of this skill (after the
task file gains a task, or a description edit) update Jira in place instead of duplicating every
issue.

## Implementation checklist

- [ ] Every task in the file has a corresponding Jira Tarefa, and every Tarefa's `parent` is the
      correct História
- [ ] Every Tarefa's Story Points match the task file exactly (no rounding, no recompute)
- [ ] Every Tarefa's description carries Description, Acceptance Criteria (as a checklist), and
      Out of Scope from the source task, plus a Source breadcrumb back to the `.md` file
- [ ] Every same-file `Depends on` produced a `Blocks` link, and no duplicate link was created on
      a re-run
- [ ] Every cross-story dependency mentioned in prose is still readable in the Jira description,
      even though it isn't a formal link
- [ ] `docs/tasks/.jira-sync.json` reflects every issue created or updated this run
- [ ] The report back names the Story and every Task with clickable URLs

## Common mistakes

- Creating a new Story every run instead of searching for/reusing the existing one — always check
  `.jira-sync.json` (and JQL as a fallback) before calling `createJiraIssue` for the Story
- Re-creating Tasks on a second run instead of updating the ones already recorded in the sync
  file — this is the #1 way to end up with duplicate issues on the board
- Dropping the story-points value or letting it drift from the task file after an edit
- Linking a task's `Depends on` to the wrong direction (the Task should be blocked *by* its
  dependency, not the other way around)
- Inventing a Jira link for a cross-story prose dependency that has no task ID to point to —
  keep it as text, don't guess a target issue
- Hardcoding a different project/board ad hoc instead of editing the fixed config table at the
  top of this skill, which is the one place it should live

## Adapting this to your squad

The project/board, issue-type IDs, and the Story Points custom field ID are all specific to this
Jira site and were resolved via `listJiraProjectIssueTypesMetadata` /
`getJiraIssueTypeMetaWithFields` against project `MPT` — re-run those two calls and update the
config table above if the team ever migrates boards or the field IDs change. What stays fixed
regardless of squad: one Jira Story per source spec, one Jira Task per generated task parented to
it, no field silently dropped in the transfer, and a durable sync record so the skill is safe to
re-run.
