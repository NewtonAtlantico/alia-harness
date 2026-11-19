# e2e-pipeline

`SKILL.md` here defines the `requirements-to-tasks-pipeline` skill: a sequential, gated pipeline that
turns business input into an estimated task backlog by calling other skills in a fixed order.
(The folder is `e2e-pipeline`; the skill's name, used by `use_skill` and `/name`, comes from the
`name:` field in its frontmatter.)

| Stage | Skill | Gate before next stage |
|---|---|---|
| 1. Requirements | `requirement-extraction-from-documents` (+ `requirement-extraction-from-threads` for transcripts, `ticket-to-brief` for thin asks) | All open questions answered |
| 2. Architecture | `architecture-from-requirements` | No blocking open questions / ADR conflicts |
| 3. Specs | `constitution-to-specs` (fed architecture + requirements) | Constraint/persona gaps resolved; specs reviewed |
| 4. Tasks | `spec-to-tasks` (once per spec) | — hands off to `issue-writer` / `add-tasks-to-jira` |

Artifacts go to the target project (`docs/requirements/`, `docs/architecture/`, `adr/`,
`docs/specs/`, `docs/tasks/`) with a resumable `docs/pipeline/STATE.md`.

## The stage skills live next to this folder

Every skill the pipeline calls is a sibling folder under `skills/` (this folder used to carry its own
copy in `e2e-pipeline/skills/`; that duplicate was removed, so there is one source of truth).

## Running it

- **Alia harness:** `/requirements-to-tasks-pipeline <input files>` (or let the model load it with
  `use_skill`). Because the harness has `run_subagent`, each stage runs in its own fresh agent (own
  context, own 80-step budget) and the main conversation only orchestrates: it asks the gate
  questions, records the answers and moves the stages. A stage that needs a human decision comes back
  `blocked` with its questions; the answers start a new subagent that resumes from the files. Without
  `run_subagent` the skill falls back to running the stages inline in one conversation. The step cap
  of the main run is 100 by default: `--max-steps <n>` in the CLI, or `ALIA_MAX_STEPS`. See
  [docs/backlog/001-subagents.md](../../docs/backlog/001-subagents.md).
- **Claude Code:** make `skills/` available as `.claude/skills/` (or `~/.claude/skills/`) and ask
  Claude to use `requirements-to-tasks-pipeline`.

**Limits:** audio/video recordings must be transcribed first; the agent cannot read them.
