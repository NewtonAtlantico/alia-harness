import { GateProgress, PipelineState, PipelineStateStore, STATE_FILE, STATE_MD_FILE, gateProgress } from '../pipeline/pipelineState.js';
import { ToolDefinition } from './types.js';

export const PIPELINE_STATE_TOOL_NAME = 'pipeline_state';

interface PipelineStateArgs {
  action?: string;
  ops?: unknown;
}

/** A compact view of the state for the model: what stage it is at, which gates are open, what is waiting. */
function overview(state: PipelineState) {
  const gates: GateProgress[] = state.gates.map((g) => gateProgress(state, g.id));
  return {
    stages: state.stages.map((s) => ({
      stage: s.stage,
      skill: s.skill,
      status: s.status,
      artifact: s.artifact,
      gate: s.gate,
      ...(s.blockedReason ? { blockedReason: s.blockedReason } : {}),
      ...(s.staleReason ? { staleReason: s.staleReason } : {}),
    })),
    gates,
    openQuestions: state.gates.flatMap((g) => g.questions.filter((q) => q.status === 'open').map((q) => ({ gate: g.id, id: q.id, prompt: q.prompt }))),
    files: { state: STATE_FILE, markdown: STATE_MD_FILE },
  };
}

export function createPipelineStateTool(): ToolDefinition<PipelineStateArgs> {
  return {
    name: PIPELINE_STATE_TOOL_NAME,
    description:
      'Keeps the state of the requirements-to-tasks pipeline in docs/pipeline/state.json and regenerates docs/pipeline/STATE.md from it. ' +
      'Use it ONLY when running that pipeline, instead of writing STATE.md by hand. action "get" returns the current state, the gates, and the task ' +
      'counts (computed from docs/tasks, never count them yourself); action "update" applies "ops" in order, all or nothing. It enforces the pipeline\'s ' +
      'rules: a stage cannot start until the previous one is done and its gate has passed; a gate cannot pass while it has open questions; a ' +
      'deferred question must have an owner (it becomes an assumption). Operations: set_project; add_input (name, input_kind, version, path, handled_by, notes); ' +
      'set_stage (stage 1-4, status pending|running|done|blocked|stale, artifact, reason); add_question (gate G1-G3, id, prompt, kind, category, options, source, confidence); ' +
      'answer_question (id, answer, by); defer_question (id, owner, assumption); reopen_question (id); set_gate (gate, status passed|open); ' +
      'set_spec_review (spec, status draft|in_review|reviewed, by); add_assumption (text, owner, stage); add_decision (question, answer, by, adr); ' +
      'add_adr (id, title, status, path); add_note (text); mark_stale (after_stage, reason). ' +
      'Summaries the app shows on screen (record them when you finish the stage, in addition to the markdown artifact): ' +
      'set_architecture (style, driver, contexts [names or {name, role}], recommendation approve|approve_with_notes|request_changes, notes); ' +
      'set_adr_alignment (adr, alignment aligned|misaligned, note: required when misaligned); ' +
      'set_spec (slug, title, persona, depends_on [spec slugs], constraints, path). A spec recorded with set_spec must be reviewed (set_spec_review) before gate G3 can pass. ' +
      'After stage 4, record the cross-spec check that needs reading with set_check (key "coverage", status pass|fail, detail: required when it fails, naming the criteria without a task). ' +
      'The app computes the others (story points, cycles, dependencies against the stories) from docs/tasks itself.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'update'], description: '"get" reads the state; "update" applies "ops".' },
        ops: {
          type: 'array',
          description: 'For "update": the operations, applied in order. If one is invalid nothing is changed.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', description: 'The operation name.' },
              name: { type: 'string' },
              input_kind: { type: 'string', enum: ['document', 'transcript', 'brief', 'recording', 'other'] },
              version: { type: 'string' },
              path: { type: 'string', description: 'Workspace-relative path of an input file (its hash is recorded so later changes are noticed).' },
              handled_by: { type: 'string' },
              notes: { type: 'string' },
              stage: { description: '1-4, or requirements | architecture | specs | tasks.' },
              status: { type: 'string' },
              artifact: { type: 'string' },
              reason: { type: 'string' },
              gate: { type: 'string', description: 'G1, G2 or G3.' },
              id: { type: 'string' },
              prompt: { type: 'string' },
              kind: { type: 'string', enum: ['choice', 'text', 'confirm'] },
              category: { type: 'string', enum: ['open_question', 'contradiction', 'low_confidence', 'blocker'] },
              options: { type: 'array', items: { type: 'object' } },
              source: { type: 'string' },
              confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
              answer: { description: 'The answer: an option id, text, or true/false.' },
              by: { type: 'string' },
              date: { type: 'string' },
              owner: { type: 'string' },
              assumption: { type: 'string', description: 'For defer_question: the assumption being carried forward.' },
              spec: { type: 'string' },
              text: { type: 'string' },
              question: { type: 'string' },
              question_id: { type: 'string' },
              adr: { type: 'string' },
              title: { type: 'string' },
              after_stage: { description: '1, 2 or 3: the stage whose artifact changed.' },
              style: { type: 'string', description: 'set_architecture: the architectural style.' },
              driver: { type: 'string', description: 'set_architecture: what drove the choice of style.' },
              contexts: { type: 'array', description: 'set_architecture: bounded contexts, as names or { name, role }.', items: {} },
              recommendation: { type: 'string', enum: ['approve', 'approve_with_notes', 'request_changes'] },
              alignment: { type: 'string', enum: ['aligned', 'misaligned'], description: 'set_adr_alignment' },
              note: { type: 'string', description: 'set_adr_alignment: where the proposal departs from the ADR.' },
              slug: { type: 'string', description: 'set_spec: the spec slug (for example login-sso).' },
              persona: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' }, description: 'set_spec: slugs of the specs this one depends on.' },
              constraints: { type: 'array', items: { type: 'string' } },
              key: { type: 'string', description: 'set_check: the check, for example coverage (every acceptance criterion has a task).' },
              detail: { type: 'string', description: 'set_check: what is wrong (required for fail).' },
            },
            required: ['op'],
          },
        },
      },
      required: ['action'],
    },
    execute: async (args, ctx) => {
      const store = new PipelineStateStore(ctx.workingDirectory);

      if (args?.action === 'get') {
        let state: PipelineState | undefined;
        try {
          state = store.load();
        } catch (err: any) {
          return `Error: ${err.message}`;
        }
        if (!state) {
          return JSON.stringify({ exists: false, hint: 'No pipeline state yet. Create it with action "update" (for example add_input operations for the inputs).' }, null, 2);
        }
        const tasks = store.tasks();
        return JSON.stringify(
          {
            exists: true,
            project: state.project,
            ...overview(state),
            inputs: state.inputs.map(({ hash, size, ...i }) => i),
            questions: state.gates.flatMap((g) => g.questions.map((q) => ({ gate: g.id, ...q }))),
            specReviews: state.specReviews,
            assumptions: state.assumptions,
            decisions: state.decisions,
            adrs: state.adrs,
            ...(state.architecture ? { architecture: state.architecture } : {}),
            adrAlignment: state.adrAlignment,
            specs: state.specs,
            notes: state.notes,
            tasks: { taskCount: tasks.taskCount, points: tasks.points, files: tasks.files.map((f) => ({ file: f.file, taskCount: f.taskCount, points: f.points })), problems: tasks.problems },
          },
          null,
          2
        );
      }

      if (args?.action === 'update') {
        const result = store.apply(args.ops);
        if (!result.ok) return `Error: ${result.error}`;
        return JSON.stringify({ ok: true, applied: (args.ops as unknown[]).length, ...overview(result.state) }, null, 2);
      }

      return 'Error: Parameter "action" must be "get" or "update".';
    },
  };
}
