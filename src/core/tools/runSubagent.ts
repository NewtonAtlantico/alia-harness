import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import OpenAI from 'openai';
import { ToolDefinition } from './types.js';
import { ToolRegistry } from './index.js';
import { AliaAgent } from '../agent/agentLoop.js';
import { ContextManager } from '../context/contextManager.js';
import { AliaModelConfig } from '../config.js';
import { AgentEvent } from '../agent/events.js';
import { SkillRegistry, buildSkillInvocationPrompt } from '../skills/skillLoader.js';
import { resolveFileMentions } from '../context/fileMentions.js';
import {
  SubagentReport,
  formatSubagentReport,
  parseSubagentReport,
} from '../agent/subagentResult.js';

export const RUN_SUBAGENT_TOOL_NAME = 'run_subagent';
export const DEFAULT_SUBAGENT_STEPS = 40;
export const MAX_SUBAGENT_STEPS = 80;

/** Appended to the parent's system prompt to turn the child into a non-interactive worker. */
export const SUBAGENT_PROMPT_BLOCK = `## Subagent mode
You are a subagent: you were started by another agent to do ONE delegated task in a clean context.
- There is no user to talk to. Never ask questions mid-task; decide, or stop at a gate (see below).
- The caller sees only your final message. Write every deliverable to a file and name it there.
- If you cannot continue without a human decision, stop, write the open questions into the relevant file, and finish with STATUS: blocked.
- Finish with exactly this block as your final message:
STATUS: completed | blocked | failed
SUMMARY: <what you did, a few sentences>
ARTIFACTS: <comma-separated paths of the files you created or changed>
QUESTIONS: <only when blocked: the decisions you need from the user>`;

export interface SubagentDeps {
  /** Live getters, so `/model` switches made in the REPL apply to later subagents. */
  getClient: () => OpenAI;
  getModel: () => { id: string; config: AliaModelConfig };
  /** The parent's registry; the child gets a copy without `run_subagent` (depth 1 only). */
  getRegistry: () => ToolRegistry;
  /** The parent's full system prompt (base + skill catalog). */
  systemPrompt: string;
  /** Needed for the `skill` argument; without it that argument returns an error. */
  getSkills?: () => SkillRegistry;
  /**
   * Show the child's full transcript, indented, instead of one line per tool call.
   * Defaults to the ALIA_SUBAGENT_VERBOSE=1 environment variable.
   */
  verbose?: boolean;
}

interface RunSubagentArgs {
  task: string;
  skill?: string;
  inputs?: string[];
  max_steps?: number;
}

function clampSteps(requested: unknown): number {
  const n = typeof requested === 'number' && Number.isFinite(requested) ? Math.floor(requested) : DEFAULT_SUBAGENT_STEPS;
  return Math.min(Math.max(n, 1), MAX_SUBAGENT_STEPS);
}

/** Artifacts the child listed that do not exist on disk (relative to the working directory). */
function missingArtifacts(report: SubagentReport, cwd: string): string[] {
  return report.artifacts.filter((p) => !fs.existsSync(path.resolve(cwd, p)));
}

/**
 * `run_subagent`: runs a task in a fresh, isolated agent (own history, own step budget) and
 * returns only a short STATUS/SUMMARY/ARTIFACTS/QUESTIONS block. Files are the hand-off
 * channel; the child's conversation never enters the parent's history.
 */
export function createRunSubagentTool(deps: SubagentDeps): ToolDefinition<RunSubagentArgs> {
  return {
    name: RUN_SUBAGENT_TOOL_NAME,
    description:
      'Runs a self-contained task in a fresh, isolated subagent with its own context and step budget, ' +
      'and returns a short result block (STATUS, SUMMARY, ARTIFACTS, QUESTIONS). Use it for a heavy, ' +
      'separable stage so its details do not fill your context. The subagent cannot ask the user: if it ' +
      'returns STATUS: blocked, ask the user its QUESTIONS yourself, then start a new subagent with the answers. ' +
      'Put everything it needs in "task" (constraints, where to write results); it cannot see this conversation. ' +
      'Use "skill" to start it with a skill already loaded, and "inputs" to hand it files.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Complete, self-contained instructions for the subagent, including output file paths.',
        },
        skill: {
          type: 'string',
          description: 'Optional skill name (as listed in the system prompt) to pre-load, so the subagent does not need to call use_skill.',
        },
        inputs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional file or directory paths (relative to the working directory) whose contents are attached to the subagent\'s first message.',
        },
        max_steps: {
          type: 'number',
          description: `Step budget for the subagent (default ${DEFAULT_SUBAGENT_STEPS}, max ${MAX_SUBAGENT_STEPS}).`,
        },
      },
      required: ['task'],
    },
    execute: async (args, ctx) => {
      if (!args?.task || !args.task.trim()) return 'Error: Parameter "task" is required.';

      // Validate everything before spawning: a bad skill name or input path should cost the
      // parent one cheap tool error, not a child run that wanders without its inputs.
      let firstMessage = args.task.trim();

      if (args.inputs !== undefined) {
        if (!Array.isArray(args.inputs) || args.inputs.some((p) => typeof p !== 'string' || !p.trim())) {
          return 'Error: Parameter "inputs" must be an array of file or directory paths.';
        }
        if (args.inputs.length > 0) {
          const resolved = resolveFileMentions(
            `Input files: ${args.inputs.map((p) => `@${p.trim()}`).join(' ')}`,
            ctx.workingDirectory
          );
          if (resolved.errors.length > 0) {
            return `Error: could not attach inputs, so no subagent was started:\n${resolved.errors.join('\n')}`;
          }
          firstMessage = `${firstMessage}\n\n${resolved.prompt}`;
        }
      }

      if (args.skill) {
        const skills = deps.getSkills?.();
        if (!skills) return 'Error: Skills are not available in this harness, so "skill" cannot be used.';
        const name = args.skill.replace(/^\//, '');
        const skill = skills.get(name);
        if (!skill) {
          const names = skills.available().map((s) => s.name).join(', ') || '(none)';
          return `Error: Unknown skill "${args.skill}". Available skills: ${names}`;
        }
        const missing = skills.missingRequirements(skill);
        if (missing.length > 0) {
          return `Error: Skill "${skill.name}" is unavailable in this harness: it requires ${missing.join(', ')} (no matching tool is registered).`;
        }
        firstMessage = buildSkillInvocationPrompt(skill, skills, firstMessage);
      }

      const maxSteps = clampSteps(args.max_steps);
      const { id, config } = deps.getModel();
      const subagentId = randomUUID();
      const emit = ctx.emit;

      const child = new AliaAgent({
        client: deps.getClient(),
        model: id,
        modelConfig: config,
        toolRegistry: deps.getRegistry().without(
          [RUN_SUBAGENT_TOOL_NAME],
          'Tool "run_subagent" is not available inside a subagent: subagents cannot start other subagents. Do the work yourself.'
        ),
        safetyChecker: ctx.safetyChecker,
        contextManager: new ContextManager({ maxInputTokens: config.maxInputTokens || 128000 }),
        workingDirectory: ctx.workingDirectory,
        systemPrompt: `${deps.systemPrompt}\n\n${SUBAGENT_PROMPT_BLOCK}`,
        maxSteps,
        // Everything the child reports reaches the parent's observers, tagged with this child's id.
        onEvent: emit ? (e) => emit({ subagentId, ...e } as AgentEvent) : undefined,
      });

      const label = args.task.trim().split('\n')[0].slice(0, 100);
      const verbose = deps.verbose ?? process.env.ALIA_SUBAGENT_VERBOSE === '1';
      emit?.({
        type: 'subagent_started',
        id: subagentId,
        parentToolCallId: ctx.toolCallId,
        label,
        maxSteps,
        skill: args.skill,
        quiet: !verbose,
      });
      let result;
      try {
        // The child shares the parent's cancellation: aborting the parent stops the child too.
        result = await child.runDetailed(firstMessage, { signal: ctx.signal });
      } catch (err) {
        emit?.({ type: 'subagent_finished', id: subagentId, label, status: 'failed', steps: 0, maxSteps });
        throw err;
      }

      let report: SubagentReport;
      if (result.status === 'completed') {
        report = parseSubagentReport(result.text);
        const missing = report.status === 'completed' ? missingArtifacts(report, ctx.workingDirectory) : [];
        if (missing.length > 0) {
          report = {
            ...report,
            status: 'failed',
            summary: `Subagent reported completion but these listed artifacts do not exist: ${missing.join(', ')}. Its own summary: ${report.summary}`,
          };
        }
      } else {
        report = { status: result.status === 'max_steps' ? 'max_steps' : 'failed', summary: result.text, artifacts: [], questions: '' };
      }

      emit?.({ type: 'subagent_finished', id: subagentId, label, status: result.status === 'cancelled' ? 'cancelled' : report.status, steps: result.steps, maxSteps });
      return formatSubagentReport(report, { steps: result.steps, maxSteps });
    },
  };
}
