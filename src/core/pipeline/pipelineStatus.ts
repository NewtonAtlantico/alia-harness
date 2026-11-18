import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  GateId,
  GateProgress,
  PipelineState,
  PipelineStateError,
  PipelineStateStore,
  STATE_MD_FILE,
  StageNumber,
  StageStatus,
  gateProgress,
} from './pipelineState.js';
import { TaskStats } from './taskStats.js';

/**
 * Where a pipeline stopped, and what comes next, read from `state.json` alone, so a session can be
 * resumed after the app was closed (or a different model takes over) without anything remembered.
 */

export interface StaleInput {
  name: string;
  path: string;
  /** `changed`: the file's content is not what was inventoried. `missing`: it is gone. */
  reason: 'changed' | 'missing';
}

export type PipelineNext =
  /** There is no state: start with the intake step. */
  | { kind: 'not_started' }
  /** state.json cannot be read; nothing is changed until it is fixed. */
  | { kind: 'damaged'; message: string }
  /** An input file is no longer what was inventoried: the user decides whether to redo from stage 1. */
  | { kind: 'inputs_changed'; inputs: StaleInput[] }
  /** A gate has open questions. */
  | { kind: 'answer_questions'; gate: GateId; stage: StageNumber; open: Array<{ id: string; prompt: string }>; answered: number; total: number }
  /** Gate 3 needs the human review of every spec. */
  | { kind: 'review_specs'; gate: 'G3'; unreviewed: string[] }
  /** A stage finished and its gate has no open questions, but the user has not approved moving on. */
  | { kind: 'pass_gate'; gate: GateId; stage: StageNumber; nextStage: StageNumber }
  /** The next stage to run (or to redo, if stale; or to continue, if running). */
  | { kind: 'run_stage'; stage: StageNumber; skill: string; reason: StageStatus; detail?: string }
  | { kind: 'complete' };

export interface PipelineStatus {
  exists: boolean;
  project?: string;
  stages: Array<{ stage: StageNumber; skill: string; status: StageStatus; gate?: GateId; gateStatus?: string; gateProgress?: GateProgress }>;
  gates: GateProgress[];
  next: PipelineNext;
  /** One line for a header or a log ("Waiting at gate G1: 3 of 5 questions answered"). */
  summary: string;
  staleInputs: StaleInput[];
  /** Whether STATE.md matches what `state.json` renders to. `differs` often means it was edited by hand. */
  markdown: 'ok' | 'missing' | 'differs' | 'n/a';
  tasks?: Pick<TaskStats, 'taskCount' | 'points' | 'problems'>;
  /** A ready-made prompt that tells the model where it is and what to do next. */
  resumePrompt: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Inputs recorded with a path and hash whose file has since changed or disappeared. */
export function findStaleInputs(workspace: string, state: PipelineState): StaleInput[] {
  const stale: StaleInput[] = [];
  for (const input of state.inputs) {
    if (!input.path || !input.hash) continue;
    let data: Buffer;
    try {
      data = fs.readFileSync(path.resolve(workspace, input.path));
    } catch {
      stale.push({ name: input.name, path: input.path, reason: 'missing' });
      continue;
    }
    if (crypto.createHash('sha256').update(data).digest('hex') !== input.hash) {
      stale.push({ name: input.name, path: input.path, reason: 'changed' });
    }
  }
  return stale;
}

/** The first thing that is not finished, in pipeline order. */
export function nextStep(state: PipelineState, staleInputs: StaleInput[]): PipelineNext {
  if (staleInputs.length > 0) return { kind: 'inputs_changed', inputs: staleInputs };

  for (const stage of state.stages) {
    const gateId = stage.gate;
    if (gateId) {
      const p = gateProgress(state, gateId);
      if (p.open > 0) {
        const gate = state.gates.find((g) => g.id === gateId)!;
        return {
          kind: 'answer_questions',
          gate: gateId,
          stage: stage.stage,
          open: gate.questions.filter((q) => q.status === 'open').map((q) => ({ id: q.id, prompt: q.prompt })),
          answered: p.answered + p.deferred,
          total: p.total,
        };
      }
    }
    if (stage.status !== 'done') {
      const detail = stage.status === 'blocked' ? stage.blockedReason : stage.status === 'stale' ? stage.staleReason : undefined;
      return { kind: 'run_stage', stage: stage.stage, skill: stage.skill, reason: stage.status, ...(detail ? { detail } : {}) };
    }
    if (gateId && gateProgress(state, gateId).status !== 'passed') {
      if (gateId === 'G3') {
        const unreviewed = state.specReviews.filter((r) => r.status !== 'reviewed').map((r) => r.spec);
        if (unreviewed.length > 0) return { kind: 'review_specs', gate: 'G3', unreviewed };
      }
      return { kind: 'pass_gate', gate: gateId, stage: stage.stage, nextStage: (stage.stage + 1) as StageNumber };
    }
  }
  return { kind: 'complete' };
}

function summarize(state: PipelineState, next: PipelineNext, tasks?: PipelineStatus['tasks']): string {
  switch (next.kind) {
    case 'not_started':
      return 'The pipeline has not started.';
    case 'damaged':
      return `state.json cannot be read: ${next.message}`;
    case 'inputs_changed':
      return `Input changed since it was inventoried: ${next.inputs.map((i) => i.name).join(', ')}.`;
    case 'answer_questions':
      return `Waiting at gate ${next.gate}: ${next.answered} of ${next.total} questions answered.`;
    case 'review_specs':
      return `Waiting at gate G3: ${plural(next.unreviewed.length, 'spec')} still to review (${next.unreviewed.join(', ')}).`;
    case 'pass_gate':
      return `Gate ${next.gate} is ready: waiting for approval to move on to stage ${next.nextStage}.`;
    case 'run_stage': {
      const verb = next.reason === 'running' ? 'In progress' : next.reason === 'stale' ? 'To redo (stale)' : next.reason === 'blocked' ? 'Blocked' : 'Next';
      return `${verb}: stage ${next.stage} (${next.skill})${next.detail ? `: ${next.detail}` : ''}.`;
    }
    case 'complete':
      return `Complete${tasks && tasks.taskCount > 0 ? `: ${plural(tasks.taskCount, 'task')}, ${plural(tasks.points, 'point')}` : ''}.`;
  }
}

function instruction(next: PipelineNext): string {
  switch (next.kind) {
    case 'not_started':
      return 'There is no pipeline state yet. Start with Step 0 (intake): inventory the inputs and record them with `pipeline_state` (`add_input`).';
    case 'damaged':
      return `docs/pipeline/state.json is damaged (${next.message}). Do not change anything: tell the user, and ask how to proceed.`;
    case 'inputs_changed':
      return [
        `These input files are no longer what was inventoried: ${next.inputs.map((i) => `${i.name} (${i.reason}, ${i.path})`).join('; ')}.`,
        'Tell the user what changed and ask whether to redo the pipeline from stage 1. If yes, mark stage 1 stale with `pipeline_state` (`set_stage` with status `stale` and a reason, then `mark_stale` with `after_stage: 1`) and refresh the inventory (`add_input` again with the same path). If no, refresh the inventory and carry on.',
      ].join(' ');
    case 'answer_questions':
      return [
        `Gate ${next.gate} has ${plural(next.open.length, 'open question')}. The ${next.answered} already answered or deferred are recorded in the state: do not ask them again.`,
        `Open: ${next.open.map((q) => `${q.id} ("${q.prompt}")`).join('; ')}.`,
        'Ask exactly these with `ask_user` (or, if it is not available, as a plain list), record each answer with `pipeline_state` `answer_question` (or `defer_question`, which needs an owner), and call `set_gate` only when none is open and the user has approved moving on.',
      ].join(' ');
    case 'review_specs':
      return `Gate G3 needs the user's review of these specs: ${next.unreviewed.join(', ')}. Do not start stage 4. Ask the user to review them, record each with \`pipeline_state\` \`set_spec_review\`, then \`set_gate\`.`;
    case 'pass_gate':
      return `Stage ${next.stage} is done and gate ${next.gate} has no open questions. Ask the user to confirm moving on to stage ${next.nextStage}; on approval call \`pipeline_state\` \`set_gate\` (passed), then continue.`;
    case 'run_stage':
      return `${next.reason === 'running' ? 'Continue' : next.reason === 'stale' ? 'Redo' : next.reason === 'blocked' ? 'Unblock' : 'Run'} stage ${next.stage} with the \`${next.skill}\` skill${next.detail ? ` (${next.detail})` : ''}. Set its status with \`pipeline_state\` \`set_stage\`.`;
    case 'complete':
      return 'Every stage is done and every gate has passed. Give the final report (artifacts, ADRs, specs, tasks and points, assumptions with owners), and suggest `issue-writer` to publish the tasks.';
  }
}

function buildResumePrompt(state: PipelineState | undefined, next: PipelineNext, summary: string): string {
  return [
    'Resume the requirements-to-tasks pipeline in this project, with the `requirements-to-tasks-pipeline` skill.',
    state
      ? 'Its state is in docs/pipeline/state.json: read it with `pipeline_state` (action `get`). Do not redo stages that are done, and do not ask a question that is already answered.'
      : '',
    `Where it stopped: ${summary}`,
    `What to do: ${instruction(next)}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** Where the pipeline in `workspace` stands. Never throws, never changes anything. */
export function getPipelineStatus(workspace: string): PipelineStatus {
  const store = new PipelineStateStore(workspace);
  let state: PipelineState | undefined;
  try {
    state = store.load();
  } catch (err: any) {
    const message = err instanceof PipelineStateError ? err.message : String(err?.message ?? err);
    const next: PipelineNext = { kind: 'damaged', message };
    const summary = summarize({} as PipelineState, next);
    return { exists: true, stages: [], gates: [], next, summary, staleInputs: [], markdown: 'n/a', resumePrompt: buildResumePrompt(undefined, next, summary) };
  }
  if (!state) {
    const next: PipelineNext = { kind: 'not_started' };
    const summary = summarize({} as PipelineState, next);
    return { exists: false, stages: [], gates: [], next, summary, staleInputs: [], markdown: 'n/a', resumePrompt: buildResumePrompt(undefined, next, summary) };
  }

  const staleInputs = findStaleInputs(store.workspace, state);
  const next = nextStep(state, staleInputs);
  const taskStats = store.tasks();
  const tasks = { taskCount: taskStats.taskCount, points: taskStats.points, problems: taskStats.problems };
  const summary = summarize(state, next, tasks);

  let markdown: PipelineStatus['markdown'];
  try {
    markdown = fs.readFileSync(path.join(store.workspace, STATE_MD_FILE), 'utf-8').replace(/\r\n/g, '\n') === store.render(state) ? 'ok' : 'differs';
  } catch {
    markdown = 'missing';
  }

  return {
    exists: true,
    project: state.project,
    stages: state.stages.map((s) => ({
      stage: s.stage,
      skill: s.skill,
      status: s.status,
      ...(s.gate ? { gate: s.gate, gateStatus: gateProgress(state!, s.gate).status, gateProgress: gateProgress(state!, s.gate) } : {}),
    })),
    gates: state.gates.map((g) => gateProgress(state!, g.id)),
    next,
    summary,
    staleInputs,
    markdown,
    tasks,
    resumePrompt: buildResumePrompt(state, next, summary),
  };
}

/** Rewrites STATE.md from state.json (for when it was edited by hand, or the task files changed). */
export function refreshStateMarkdown(workspace: string): boolean {
  const store = new PipelineStateStore(workspace);
  const state = store.load();
  if (!state) return false;
  store.write(state);
  return true;
}

