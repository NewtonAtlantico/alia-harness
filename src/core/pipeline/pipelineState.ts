import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { TaskStats, summarizeTasks } from './taskStats.js';
import type { QuestionKind, QuestionOption } from '../tools/askUser.js';

/**
 * The state of the requirements-to-tasks pipeline, kept as data.
 *
 * `docs/pipeline/state.json` is the source of truth; `docs/pipeline/STATE.md` is rendered from it,
 * the same way every time, so a UI can read the state without parsing prose a model wrote freely.
 * The pipeline skill's rules are enforced here: a stage cannot start until the previous one is done
 * and its gate has passed, and a gate cannot pass while it has open questions.
 */

export const STATE_VERSION = 1;
export const STATE_FILE = 'docs/pipeline/state.json';
export const STATE_MD_FILE = 'docs/pipeline/STATE.md';

export type StageNumber = 1 | 2 | 3 | 4;
export type GateId = 'G1' | 'G2' | 'G3';
export type StageStatus = 'pending' | 'running' | 'done' | 'blocked' | 'stale';
export type GateStatus = 'pending' | 'open' | 'passed';
export type QuestionStatus = 'open' | 'answered' | 'deferred';
export type QuestionCategory = 'open_question' | 'contradiction' | 'low_confidence' | 'blocker';
export type InputKind = 'document' | 'transcript' | 'brief' | 'recording' | 'other';
export type SpecReviewStatus = 'draft' | 'in_review' | 'reviewed';

/** The four stages, their skills and default artifacts, and the gate that follows each (stage 4 has none). */
export const STAGES: ReadonlyArray<{ stage: StageNumber; key: string; skill: string; artifact: string; gate?: GateId }> = [
  { stage: 1, key: 'requirements', skill: 'requirement-extraction-from-documents', artifact: 'docs/requirements/requirements.md', gate: 'G1' },
  { stage: 2, key: 'architecture', skill: 'architecture-from-requirements', artifact: 'docs/architecture/architecture.md', gate: 'G2' },
  { stage: 3, key: 'specs', skill: 'constitution-to-specs', artifact: 'docs/specs/INDEX.md', gate: 'G3' },
  { stage: 4, key: 'tasks', skill: 'spec-to-tasks', artifact: 'docs/tasks/' },
];
const GATES: GateId[] = ['G1', 'G2', 'G3'];
const gateStage = (g: GateId): StageNumber => (GATES.indexOf(g) + 1) as StageNumber;

export interface PipelineInput {
  name: string;
  version?: string;
  kind: InputKind;
  /** The skill that reads it (e.g. `requirement-extraction-from-documents`). */
  handledBy?: string;
  notes?: string;
  /** Where the file is, and what it contained when it was inventoried (to notice later changes). */
  path?: string;
  hash?: string;
  size?: number;
}

export interface GateQuestion {
  id: string;
  prompt: string;
  kind: QuestionKind;
  category: QuestionCategory;
  options?: QuestionOption[];
  /** Where the question comes from ("BRD_v2.pdf · p. 14"). */
  source?: string;
  confidence?: 'low' | 'medium' | 'high';
  status: QuestionStatus;
  answer?: string;
  answerLabel?: string;
  /** Who answered or deferred it, and when. */
  by?: string;
  date?: string;
  /** Who owns the assumption, when deferred. */
  owner?: string;
}

export interface Gate {
  id: GateId;
  status: GateStatus;
  questions: GateQuestion[];
}

export interface PipelineStage {
  stage: StageNumber;
  skill: string;
  status: StageStatus;
  artifact: string;
  gate?: GateId;
  completedAt?: string;
  blockedReason?: string;
  staleReason?: string;
}

export interface Decision {
  question: string;
  answer: string;
  by?: string;
  date?: string;
  stage?: StageNumber;
  adr?: string;
}

export interface Assumption {
  text: string;
  owner: string;
  stage?: StageNumber;
  /** The gate question this assumption came from, if any. */
  questionId?: string;
}

export interface AdrRef {
  id: string;
  title: string;
  status: string;
  path?: string;
}

export interface SpecReview {
  spec: string;
  status: SpecReviewStatus;
  by?: string;
  date?: string;
}

export type ArchitectureRecommendation = 'approve' | 'approve_with_notes' | 'request_changes';
export type AdrAlignmentStatus = 'aligned' | 'misaligned';

export interface ArchitectureContext {
  name: string;
  /** What the context is responsible for, in a few words. */
  role?: string;
}

/** The architecture proposal in a few fields (what the gate 2 screen shows), recorded by the model. */
export interface ArchitectureSummary {
  style: string;
  /** What drove the choice of style. */
  driver?: string;
  contexts: ArchitectureContext[];
  recommendation?: ArchitectureRecommendation;
  notes?: string;
}

/** Whether the proposal agrees with an existing ADR. */
export interface AdrAlignment {
  adr: string;
  status: AdrAlignmentStatus;
  note?: string;
}

/** What gate 3 shows about a spec (the spec file itself holds the rest). */
export interface SpecSummary {
  slug: string;
  title: string;
  persona?: string;
  /** Slugs of the specs this one depends on. */
  dependsOn: string[];
  constraints: string[];
  path?: string;
}

export type CheckStatus = 'pass' | 'fail';

/** A check the model made and recorded (the cross-spec checks that need reading: does every acceptance criterion have a task?). */
export interface PipelineCheck {
  key: string;
  status: CheckStatus;
  detail?: string;
  date?: string;
}

export interface PipelineState {
  version: 1;
  updatedAt: string;
  project?: string;
  inputs: PipelineInput[];
  stages: PipelineStage[];
  gates: Gate[];
  /** Human review of each spec (gate 3). */
  specReviews: SpecReview[];
  decisions: Decision[];
  assumptions: Assumption[];
  adrs: AdrRef[];
  notes: string[];
  /** Structured summaries (absent in states written before they existed, or when the model did not record them). */
  architecture?: ArchitectureSummary;
  adrAlignment: AdrAlignment[];
  specs: SpecSummary[];
  /** Checks recorded with `set_check`, by key. */
  checks: PipelineCheck[];
}

export class PipelineStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PipelineStateError';
  }
}

// ------------------------------------------------------------------------------------ creation

export function newState(now: Date = new Date()): PipelineState {
  return {
    version: STATE_VERSION,
    updatedAt: now.toISOString(),
    inputs: [],
    stages: STAGES.map((s) => ({ stage: s.stage, skill: s.skill, status: 'pending', artifact: s.artifact, ...(s.gate ? { gate: s.gate } : {}) })),
    gates: GATES.map((id) => ({ id, status: 'pending', questions: [] })),
    specReviews: [],
    decisions: [],
    assumptions: [],
    adrs: [],
    notes: [],
    adrAlignment: [],
    specs: [],
    checks: [],
  };
}

const isObject = (v: unknown): v is Record<string, any> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Checks a parsed `state.json`. Missing lists become empty; anything structurally wrong is an error. */
export function normalizeState(raw: unknown): PipelineState {
  if (!isObject(raw)) throw new PipelineStateError('state.json must contain an object');
  if (raw.version !== STATE_VERSION) throw new PipelineStateError(`state.json has version ${JSON.stringify(raw.version)}; this harness understands version ${STATE_VERSION}`);
  const base = newState(new Date(0));
  const list = (v: unknown, name: string): any[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new PipelineStateError(`state.json: "${name}" must be a list`);
    return v;
  };
  const stages = list(raw.stages, 'stages');
  const gates = list(raw.gates, 'gates');
  const state: PipelineState = {
    version: STATE_VERSION,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : base.updatedAt,
    ...(typeof raw.project === 'string' ? { project: raw.project } : {}),
    inputs: list(raw.inputs, 'inputs'),
    stages: base.stages.map((d) => ({ ...d, ...(stages.find((s) => s?.stage === d.stage) ?? {}) })),
    gates: base.gates.map((d) => {
      const found = gates.find((g) => g?.id === d.id);
      return { ...d, ...(found ?? {}), questions: Array.isArray(found?.questions) ? found.questions : [] };
    }),
    specReviews: list(raw.specReviews, 'specReviews'),
    decisions: list(raw.decisions, 'decisions'),
    assumptions: list(raw.assumptions, 'assumptions'),
    adrs: list(raw.adrs, 'adrs'),
    notes: list(raw.notes, 'notes'),
    ...(isObject(raw.architecture)
      ? { architecture: { ...raw.architecture, contexts: Array.isArray(raw.architecture.contexts) ? raw.architecture.contexts : [] } as ArchitectureSummary }
      : {}),
    adrAlignment: list(raw.adrAlignment, 'adrAlignment'),
    specs: list(raw.specs, 'specs').map((x) => ({
      ...x,
      dependsOn: Array.isArray(x?.dependsOn) ? x.dependsOn : [],
      constraints: Array.isArray(x?.constraints) ? x.constraints : [],
    })),
    checks: list(raw.checks, 'checks'),
  };
  return state;
}

// ------------------------------------------------------------------------------------ progress

export interface GateProgress {
  gate: GateId;
  status: GateStatus;
  total: number;
  answered: number;
  deferred: number;
  open: number;
}

export function gateProgress(state: PipelineState, id: GateId): GateProgress {
  const gate = state.gates.find((g) => g.id === id)!;
  const count = (s: QuestionStatus) => gate.questions.filter((q) => q.status === s).length;
  return { gate: id, status: gate.status, total: gate.questions.length, answered: count('answered'), deferred: count('deferred'), open: count('open') };
}

const findQuestion = (state: PipelineState, id: string): { gate: Gate; question: GateQuestion } | undefined => {
  for (const gate of state.gates) {
    const question = gate.questions.find((q) => q.id === id);
    if (question) return { gate, question };
  }
  return undefined;
};

// ------------------------------------------------------------------------------------ operations

export type PipelineOp = Record<string, any> & { op: string };

export interface ApplyContext {
  now: Date;
  /** Describes a file for `add_input` (hash and size), or undefined if it cannot be read. */
  inspectFile?: (relativePath: string) => { hash: string; size: number } | undefined;
}

const OP_NAMES = [
  'set_project', 'add_input', 'set_stage', 'add_question', 'answer_question', 'defer_question', 'reopen_question',
  'set_gate', 'set_spec_review', 'add_assumption', 'add_decision', 'add_adr', 'add_note', 'mark_stale',
  'set_architecture', 'set_adr_alignment', 'set_spec', 'set_check',
];
const RECOMMENDATIONS: ArchitectureRecommendation[] = ['approve', 'approve_with_notes', 'request_changes'];
const ALIGNMENTS: AdrAlignmentStatus[] = ['aligned', 'misaligned'];
const INPUT_KINDS: InputKind[] = ['document', 'transcript', 'brief', 'recording', 'other'];
const STAGE_STATUSES: StageStatus[] = ['pending', 'running', 'done', 'blocked', 'stale'];
const QUESTION_KINDS: QuestionKind[] = ['choice', 'text', 'confirm'];
const CATEGORIES: QuestionCategory[] = ['open_question', 'contradiction', 'low_confidence', 'blocker'];
const REVIEW_STATUSES: SpecReviewStatus[] = ['draft', 'in_review', 'reviewed'];

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** A list of strings, from an array or from a comma-separated string; undefined if it is neither. */
function strList(v: unknown): string[] | undefined {
  const items = Array.isArray(v) ? v : typeof v === 'string' ? v.split(',') : undefined;
  if (!items || items.some((x) => typeof x !== 'string')) return undefined;
  const out: string[] = [];
  for (const x of items) {
    const t = str(x);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}
const day = (now: Date) => now.toISOString().slice(0, 10);

function stageNumber(v: unknown): StageNumber | undefined {
  if (typeof v === 'number' && [1, 2, 3, 4].includes(v)) return v as StageNumber;
  if (typeof v === 'string') {
    if (/^[1-4]$/.test(v.trim())) return Number(v.trim()) as StageNumber;
    return STAGES.find((s) => s.key === v.trim().toLowerCase())?.stage;
  }
  return undefined;
}

function gateId(v: unknown): GateId | undefined {
  const g = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return (GATES as string[]).includes(g) ? (g as GateId) : g.match(/^[1-3]$/) ? (`G${g}` as GateId) : undefined;
}

/**
 * Applies operations in order to a copy of the state. All or nothing: the first invalid operation
 * stops everything and nothing is changed.
 */
export function applyOps(
  current: PipelineState,
  ops: unknown,
  ctx: ApplyContext
): { ok: true; state: PipelineState } | { ok: false; error: string } {
  if (!Array.isArray(ops) || ops.length === 0) return { ok: false, error: 'Parameter "ops" must be a non-empty list of operations.' };
  const state: PipelineState = structuredClone(current);

  for (const [i, raw] of ops.entries()) {
    const fail = (message: string) => ({ ok: false as const, error: `ops[${i}]${isObject(raw) && raw.op ? ` (${raw.op})` : ''}: ${message}. Nothing was changed.` });
    if (!isObject(raw) || typeof raw.op !== 'string') return fail('each operation must be an object with an "op" field');
    if (!OP_NAMES.includes(raw.op)) return fail(`unknown operation. Known operations: ${OP_NAMES.join(', ')}`);
    const op = raw;

    switch (op.op) {
      case 'set_project': {
        const name = str(op.name);
        if (!name) return fail('"name" is required');
        state.project = name;
        break;
      }

      case 'add_input': {
        const name = str(op.name);
        if (!name) return fail('"name" is required (the file name, or a short label)');
        const kind = op.input_kind ?? 'document';
        if (!INPUT_KINDS.includes(kind)) return fail(`"input_kind" must be one of: ${INPUT_KINDS.join(', ')}`);
        const input: PipelineInput = { name, kind };
        for (const [from, to] of [['version', 'version'], ['handled_by', 'handledBy'], ['notes', 'notes'], ['path', 'path']] as const) {
          const v = str(op[from]);
          if (v) (input as any)[to] = v;
        }
        if (input.path) {
          const info = ctx.inspectFile?.(input.path);
          if (info) Object.assign(input, info);
        }
        const at = state.inputs.findIndex((x) => x.name.toLowerCase() === name.toLowerCase());
        if (at >= 0) state.inputs[at] = input;
        else state.inputs.push(input);
        break;
      }

      case 'set_stage': {
        const n = stageNumber(op.stage);
        if (!n) return fail('"stage" must be 1-4 (or requirements, architecture, specs, tasks)');
        if (!STAGE_STATUSES.includes(op.status)) return fail(`"status" must be one of: ${STAGE_STATUSES.join(', ')}`);
        const stage = state.stages.find((s) => s.stage === n)!;
        const reason = str(op.reason);
        if ((op.status === 'blocked' || op.status === 'stale') && !reason) return fail(`a "${op.status}" stage needs a "reason"`);

        if ((op.status === 'running' || op.status === 'done') && n > 1) {
          const prev = state.stages.find((s) => s.stage === n - 1)!;
          if (prev.status !== 'done') return fail(`stage ${n} cannot ${op.status === 'running' ? 'start' : 'finish'}: stage ${n - 1} is ${prev.status}, not done`);
          if (prev.gate) {
            const p = gateProgress(state, prev.gate);
            if (p.status !== 'passed') {
              return fail(`stage ${n} cannot ${op.status === 'running' ? 'start' : 'finish'}: gate ${prev.gate} has not passed (${p.open} open question${p.open === 1 ? '' : 's'}). Resolve it with the user first`);
            }
          }
        }
        stage.status = op.status;
        const artifact = str(op.artifact);
        if (artifact) stage.artifact = artifact;
        delete stage.blockedReason;
        delete stage.staleReason;
        delete stage.completedAt;
        if (op.status === 'blocked') stage.blockedReason = reason;
        if (op.status === 'stale') stage.staleReason = reason;
        if (op.status === 'done') stage.completedAt = ctx.now.toISOString();
        break;
      }

      case 'add_question': {
        const gate = gateId(op.gate);
        if (!gate) return fail('"gate" must be G1, G2 or G3');
        const id = str(op.id);
        const prompt = str(op.prompt);
        if (!id) return fail('"id" is required (a short unique id such as "q1")');
        if (!prompt) return fail('"prompt" is required');
        const kind = op.kind ?? 'text';
        if (!QUESTION_KINDS.includes(kind)) return fail(`"kind" must be one of: ${QUESTION_KINDS.join(', ')}`);
        const category = op.category ?? 'open_question';
        if (!CATEGORIES.includes(category)) return fail(`"category" must be one of: ${CATEGORIES.join(', ')}`);
        let options: QuestionOption[] | undefined;
        if (kind === 'choice') {
          if (!Array.isArray(op.options) || op.options.length < 2) return fail('a choice question needs at least two "options"');
          options = [];
          for (const o of op.options) {
            const oid = str(o?.id);
            const label = str(o?.label);
            if (!oid || !label) return fail('every option needs an "id" and a "label"');
            options.push({ id: oid, label, ...(str(o.detail) ? { detail: str(o.detail) } : {}), ...(str(o.source) ? { source: str(o.source) } : {}) });
          }
        }
        if (op.confidence !== undefined && !['low', 'medium', 'high'].includes(op.confidence)) return fail('"confidence" must be low, medium or high');

        const existing = findQuestion(state, id);
        if (existing && existing.question.status !== 'open') return fail(`question "${id}" already exists and is ${existing.question.status}; use reopen_question to ask it again`);
        if (existing && existing.gate.id !== gate) return fail(`question "${id}" already exists in gate ${existing.gate.id}`);
        const question: GateQuestion = {
          id,
          prompt,
          kind,
          category,
          ...(options ? { options } : {}),
          ...(str(op.source) ? { source: str(op.source) } : {}),
          ...(op.confidence ? { confidence: op.confidence } : {}),
          status: 'open',
        };
        const g = state.gates.find((x) => x.id === gate)!;
        if (existing) g.questions[g.questions.findIndex((q) => q.id === id)] = question;
        else g.questions.push(question);
        g.status = 'open'; // a new question reopens a gate that had passed
        break;
      }

      case 'answer_question': {
        const id = str(op.id);
        if (!id) return fail('"id" is required');
        const found = findQuestion(state, id);
        if (!found) return fail(`there is no question "${id}"`);
        const answer = typeof op.answer === 'boolean' ? (op.answer ? 'yes' : 'no') : str(op.answer);
        if (!answer) return fail('"answer" is required');
        const q = found.question;
        q.status = 'answered';
        q.answer = answer;
        const option = q.options?.find((o) => o.id === answer);
        if (option) q.answerLabel = option.label;
        else delete q.answerLabel;
        q.by = str(op.by) ?? q.by;
        q.date = str(op.date) ?? day(ctx.now);
        delete q.owner;
        state.assumptions = state.assumptions.filter((a) => a.questionId !== id); // no longer an assumption
        break;
      }

      case 'defer_question': {
        const id = str(op.id);
        if (!id) return fail('"id" is required');
        const found = findQuestion(state, id);
        if (!found) return fail(`there is no question "${id}"`);
        const owner = str(op.owner);
        if (!owner) return fail('"owner" is required: a deferred question is carried forward as an assumption, and an assumption needs an owner');
        const q = found.question;
        q.status = 'deferred';
        q.owner = owner;
        q.by = str(op.by) ?? q.by;
        q.date = str(op.date) ?? day(ctx.now);
        delete q.answer;
        delete q.answerLabel;
        const assumption: Assumption = { text: str(op.assumption) ?? `Not yet decided: ${q.prompt}`, owner, stage: gateStage(found.gate.id), questionId: id };
        const at = state.assumptions.findIndex((a) => a.questionId === id);
        if (at >= 0) state.assumptions[at] = assumption;
        else state.assumptions.push(assumption);
        break;
      }

      case 'reopen_question': {
        const id = str(op.id);
        if (!id) return fail('"id" is required');
        const found = findQuestion(state, id);
        if (!found) return fail(`there is no question "${id}"`);
        const q = found.question;
        q.status = 'open';
        for (const k of ['answer', 'answerLabel', 'owner', 'by', 'date'] as const) delete q[k];
        state.assumptions = state.assumptions.filter((a) => a.questionId !== id);
        found.gate.status = 'open';
        break;
      }

      case 'set_gate': {
        const id = gateId(op.gate);
        if (!id) return fail('"gate" must be G1, G2 or G3');
        if (op.status !== 'passed' && op.status !== 'open') return fail('"status" must be passed or open');
        const gate = state.gates.find((g) => g.id === id)!;
        if (op.status === 'passed') {
          const open = gate.questions.filter((q) => q.status === 'open').map((q) => q.id);
          if (open.length > 0) return fail(`gate ${id} cannot pass: ${open.length} question${open.length === 1 ? ' is' : 's are'} still open (${open.join(', ')}). Answer or defer ${open.length === 1 ? 'it' : 'them'} first`);
          if (id === 'G3') {
            const unreviewed = state.specReviews.filter((r) => r.status !== 'reviewed').map((r) => r.spec);
            if (unreviewed.length > 0) return fail(`gate G3 cannot pass: these specs are not reviewed yet (${unreviewed.join(', ')})`);
          }
        }
        gate.status = op.status;
        break;
      }

      case 'set_spec_review': {
        const spec = str(op.spec);
        if (!spec) return fail('"spec" is required (the spec\'s slug)');
        if (!REVIEW_STATUSES.includes(op.status)) return fail(`"status" must be one of: ${REVIEW_STATUSES.join(', ')}`);
        const review: SpecReview = { spec, status: op.status, ...(str(op.by) ? { by: str(op.by) } : {}), date: str(op.date) ?? day(ctx.now) };
        const at = state.specReviews.findIndex((r) => r.spec === spec);
        if (at >= 0) state.specReviews[at] = review;
        else state.specReviews.push(review);
        const g3 = state.gates.find((g) => g.id === 'G3')!;
        if (op.status !== 'reviewed' && g3.status === 'passed') g3.status = 'open';
        break;
      }

      case 'add_assumption': {
        const text = str(op.text);
        const owner = str(op.owner);
        if (!text) return fail('"text" is required');
        if (!owner) return fail('"owner" is required: an assumption without an owner is a dropped question');
        const stage = op.stage === undefined ? undefined : stageNumber(op.stage);
        if (op.stage !== undefined && !stage) return fail('"stage" must be 1-4');
        if (!state.assumptions.some((a) => a.text === text && a.owner === owner)) {
          state.assumptions.push({ text, owner, ...(stage ? { stage } : {}), ...(str(op.question_id) ? { questionId: str(op.question_id) } : {}) });
        }
        break;
      }

      case 'add_decision': {
        const question = str(op.question);
        const answer = str(op.answer);
        if (!question || !answer) return fail('"question" and "answer" are required');
        const stage = op.stage === undefined ? undefined : stageNumber(op.stage);
        if (op.stage !== undefined && !stage) return fail('"stage" must be 1-4');
        state.decisions.push({ question, answer, ...(str(op.by) ? { by: str(op.by) } : {}), date: str(op.date) ?? day(ctx.now), ...(stage ? { stage } : {}), ...(str(op.adr) ? { adr: str(op.adr) } : {}) });
        break;
      }

      case 'add_adr': {
        const id = str(op.id);
        const title = str(op.title);
        if (!id || !title) return fail('"id" and "title" are required');
        const adr: AdrRef = { id, title, status: str(op.status) ?? 'Proposed', ...(str(op.path) ? { path: str(op.path) } : {}) };
        const at = state.adrs.findIndex((a) => a.id === id);
        if (at >= 0) state.adrs[at] = adr;
        else state.adrs.push(adr);
        break;
      }

      case 'add_note': {
        const text = str(op.text);
        if (!text) return fail('"text" is required');
        state.notes.push(text);
        break;
      }

      case 'set_architecture': {
        const style = str(op.style);
        if (!style) return fail('"style" is required (for example "modular monolith")');
        if (op.recommendation !== undefined && !RECOMMENDATIONS.includes(op.recommendation)) return fail(`"recommendation" must be one of: ${RECOMMENDATIONS.join(', ')}`);
        const contexts: ArchitectureContext[] = [];
        if (op.contexts !== undefined) {
          if (!Array.isArray(op.contexts)) return fail('"contexts" must be a list of names, or of { name, role } objects');
          for (const c of op.contexts) {
            const name = typeof c === 'string' ? str(c) : str(c?.name);
            if (!name) return fail('every context needs a "name"');
            const role = typeof c === 'string' ? undefined : str(c?.role);
            if (!contexts.some((x) => x.name === name)) contexts.push({ name, ...(role ? { role } : {}) });
          }
        }
        state.architecture = {
          style,
          ...(str(op.driver) ? { driver: str(op.driver) } : {}),
          contexts,
          ...(op.recommendation ? { recommendation: op.recommendation } : {}),
          ...(str(op.notes) ? { notes: str(op.notes) } : {}),
        };
        break;
      }

      case 'set_adr_alignment': {
        const adr = str(op.adr);
        if (!adr) return fail('"adr" is required (the ADR id, for example ADR-0003)');
        const status = op.alignment ?? op.status;
        if (!ALIGNMENTS.includes(status)) return fail(`"alignment" must be one of: ${ALIGNMENTS.join(', ')}`);
        const note = str(op.note);
        if (status === 'misaligned' && !note) return fail('a misaligned ADR needs a "note" saying where the proposal departs from it');
        const row: AdrAlignment = { adr, status, ...(note ? { note } : {}) };
        const at = state.adrAlignment.findIndex((a) => a.adr === adr);
        if (at >= 0) state.adrAlignment[at] = row;
        else state.adrAlignment.push(row);
        break;
      }

      case 'set_spec': {
        const slug = str(op.slug);
        const title = str(op.title);
        if (!slug || !/^[\w.-]+$/.test(slug)) return fail('"slug" is required and must be a short name without spaces (for example "login-sso")');
        if (!title) return fail('"title" is required');
        const dependsOn = op.depends_on === undefined ? [] : strList(op.depends_on);
        if (!dependsOn) return fail('"depends_on" must be a list of spec slugs (or a comma-separated string)');
        if (dependsOn.includes(slug)) return fail('a spec cannot depend on itself');
        const constraints = op.constraints === undefined ? [] : strList(op.constraints);
        if (!constraints) return fail('"constraints" must be a list of short texts');
        const spec: SpecSummary = { slug, title, ...(str(op.persona) ? { persona: str(op.persona) } : {}), dependsOn, constraints, ...(str(op.path) ? { path: str(op.path) } : {}) };
        const at = state.specs.findIndex((x) => x.slug === slug);
        if (at >= 0) state.specs[at] = spec;
        else state.specs.push(spec);
        // A spec nobody has reviewed yet must be reviewed before gate 3 can pass.
        if (!state.specReviews.some((r) => r.spec === slug)) {
          state.specReviews.push({ spec: slug, status: 'draft' });
          const g3 = state.gates.find((g) => g.id === 'G3')!;
          if (g3.status === 'passed') g3.status = 'open';
        }
        break;
      }

      case 'set_check': {
        const key = str(op.key);
        if (!key || !/^[\w.-]+$/.test(key)) return fail('"key" is required and must be a short name without spaces (for example "coverage")');
        if (op.status !== 'pass' && op.status !== 'fail') return fail('"status" must be pass or fail');
        if (op.status === 'fail' && !str(op.detail)) return fail('a failing check needs a "detail": what is wrong, so the person can fix it');
        const check: PipelineCheck = { key, status: op.status, ...(str(op.detail) ? { detail: str(op.detail) } : {}), date: str(op.date) ?? day(ctx.now) };
        const at = state.checks.findIndex((c) => c.key === key);
        if (at >= 0) state.checks[at] = check;
        else state.checks.push(check);
        break;
      }

      case 'mark_stale': {
        const after = stageNumber(op.after_stage);
        const reason = str(op.reason);
        if (!after || after > 3) return fail('"after_stage" must be 1, 2 or 3: the stage whose artifact changed');
        if (!reason) return fail('"reason" is required');
        for (const stage of state.stages.filter((s) => s.stage > after && (s.status === 'done' || s.status === 'running'))) {
          stage.status = 'stale';
          stage.staleReason = reason;
          delete stage.completedAt;
          // A stage that will be redone has to pass its gate again.
          const gate = stage.gate && state.gates.find((g) => g.id === stage.gate);
          if (gate && gate.status === 'passed') gate.status = 'pending';
        }
        break;
      }
    }
  }

  state.updatedAt = ctx.now.toISOString();
  return { ok: true, state };
}

// ------------------------------------------------------------------------------------ rendering

const cell = (v: unknown) => String(v ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();

function gateCell(state: PipelineState, gate: GateId | undefined): string {
  if (!gate) return '—';
  const p = gateProgress(state, gate);
  if (p.total === 0) return `${gate}: ${p.status}`;
  const done = p.answered + p.deferred;
  return `${gate}: ${p.status} (${done} of ${p.total} answered${p.deferred ? `, ${p.deferred} deferred` : ''})`;
}

/** The human-readable view of the state. Pure and deterministic: the same state always gives the same text. */
export function renderStateMd(state: PipelineState, tasks?: TaskStats): string {
  const out: string[] = ['# Pipeline state', `**Last updated:** ${state.updatedAt.slice(0, 10)}`];
  if (state.project) out.push(`**Project:** ${cell(state.project)}`);
  out.push('', '_Generated from `docs/pipeline/state.json`. Change the state through the `pipeline_state` tool, not by editing this file._', '');

  out.push('## Inputs', '| # | Name / version | Kind | Handled by | Notes |', '|---|---|---|---|---|');
  state.inputs.forEach((i, n) => out.push(`| ${n + 1} | ${cell(i.name)}${i.version ? ` (${cell(i.version)})` : ''} | ${i.kind} | ${cell(i.handledBy ?? '')} | ${cell(i.notes ?? '')} |`));
  if (state.inputs.length === 0) out.push('| | _none recorded_ | | | |');

  out.push('', '## Stages', '| Stage | Skill | Status | Artifact | Gate |', '|---|---|---|---|---|');
  for (const s of state.stages) {
    const status = s.status === 'blocked' ? `blocked: ${cell(s.blockedReason)}` : s.status === 'stale' ? `stale: ${cell(s.staleReason)}` : s.status;
    const derived = s.stage === 4 && tasks && tasks.taskCount > 0 ? ` (${tasks.taskCount} tasks, ${tasks.points} points)` : '';
    out.push(`| ${s.stage} | ${s.skill} | ${status} | ${cell(s.artifact)}${derived} | ${gateCell(state, s.gate)} |`);
  }

  const open = state.gates.flatMap((g) => g.questions.filter((q) => q.status === 'open').map((q) => ({ g, q })));
  if (open.length > 0) {
    out.push('', '## Open questions', '| Gate | Id | Question | Source |', '|---|---|---|---|');
    for (const { g, q } of open) out.push(`| ${g.id} | ${q.id} | ${cell(q.prompt)} | ${cell(q.source ?? '')} |`);
  }

  out.push('', '## Decisions & answered questions', '| Question | Answer | By | Date |', '|---|---|---|---|');
  const rows: string[] = [];
  for (const g of state.gates) {
    for (const q of g.questions.filter((x) => x.status === 'answered')) rows.push(`| ${cell(q.prompt)} | ${cell(q.answerLabel ?? q.answer)} | ${cell(q.by ?? '')} | ${cell(q.date ?? '')} |`);
  }
  for (const d of state.decisions) rows.push(`| ${cell(d.question)} | ${cell(d.answer)}${d.adr ? ` (${cell(d.adr)})` : ''} | ${cell(d.by ?? '')} | ${cell(d.date ?? '')} |`);
  out.push(...(rows.length > 0 ? rows : ['| _none yet_ | | | |']));

  out.push('', '## Assumptions carried forward', '| Assumption | Owner | Stage introduced |', '|---|---|---|');
  state.assumptions.forEach((a) => out.push(`| ${cell(a.text)} | ${cell(a.owner)} | ${a.stage ?? ''} |`));
  if (state.assumptions.length === 0) out.push('| _none_ | | |');

  if (state.architecture) {
    const a = state.architecture;
    const labels: Record<ArchitectureRecommendation, string> = { approve: 'approve', approve_with_notes: 'approve with notes', request_changes: 'request changes' };
    out.push('', '## Architecture', `**Style:** ${cell(a.style)}`);
    if (a.driver) out.push(`**Driver:** ${cell(a.driver)}`);
    if (a.recommendation) out.push(`**Review recommendation:** ${labels[a.recommendation] ?? cell(a.recommendation)}`);
    if (a.notes) out.push(`**Notes:** ${cell(a.notes)}`);
    if (a.contexts.length > 0) out.push('', '| Context | Responsibility |', '|---|---|', ...a.contexts.map((c) => `| ${cell(c.name)} | ${cell(c.role ?? '')} |`));
  }
  if (state.adrAlignment.length > 0) {
    out.push('', '## ADR alignment', '| ADR | Alignment | Note |', '|---|---|---|');
    state.adrAlignment.forEach((a) => out.push(`| ${cell(a.adr)} | ${a.status} | ${cell(a.note ?? '')} |`));
  }
  if (state.specs.length > 0) {
    out.push('', '## Specs', '| Spec | Title | Persona | Depends on | Constraints |', '|---|---|---|---|---|');
    state.specs.forEach((s) => out.push(`| ${cell(s.slug)} | ${cell(s.title)} | ${cell(s.persona ?? '')} | ${cell(s.dependsOn.join(', ') || '—')} | ${cell(s.constraints.join('; '))} |`));
  }
  if (state.specReviews.length > 0) {
    out.push('', '## Spec review (gate 3)', '| Spec | Status | By | Date |', '|---|---|---|---|');
    state.specReviews.forEach((r) => out.push(`| ${cell(r.spec)} | ${r.status} | ${cell(r.by ?? '')} | ${cell(r.date ?? '')} |`));
  }
  if (state.adrs.length > 0) {
    out.push('', '## ADRs', '| Id | Title | Status |', '|---|---|---|');
    state.adrs.forEach((a) => out.push(`| ${cell(a.id)} | ${cell(a.title)} | ${cell(a.status)} |`));
  }
  if (state.checks.length > 0) {
    out.push('', '## Cross-spec checks', '| Check | Result | Detail |', '|---|---|---|');
    state.checks.forEach((c) => out.push(`| ${cell(c.key)} | ${c.status} | ${cell(c.detail ?? '')} |`));
  }
  if (tasks && tasks.problems.length > 0) {
    out.push('', '## Backlog problems', ...tasks.problems.map((p) => `- ${p}`));
  }
  if (state.notes.length > 0) out.push('', '## Notes', ...state.notes.map((n) => `- ${n.replace(/\s*\n\s*/g, ' ')}`));
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------------------------------ store

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, file);
}

export interface PipelineStateStoreOptions {
  now?: () => Date;
}

/** Reads and writes a project's pipeline state (and keeps `STATE.md` in step). */
export class PipelineStateStore {
  readonly workspace: string;
  readonly statePath: string;
  readonly markdownPath: string;
  private now: () => Date;

  constructor(workspace: string, options: PipelineStateStoreOptions = {}) {
    this.workspace = path.resolve(workspace);
    this.statePath = path.join(this.workspace, STATE_FILE);
    this.markdownPath = path.join(this.workspace, STATE_MD_FILE);
    this.now = options.now ?? (() => new Date());
  }

  exists(): boolean {
    return fs.existsSync(this.statePath);
  }

  /** The state, or undefined if there is none yet. A damaged file throws (it is never overwritten silently). */
  load(): PipelineState | undefined {
    let raw: string;
    try {
      raw = fs.readFileSync(this.statePath, 'utf-8');
    } catch {
      return undefined;
    }
    try {
      return normalizeState(JSON.parse(raw));
    } catch (err: any) {
      if (err instanceof PipelineStateError) throw err;
      throw new PipelineStateError(`${STATE_FILE} is damaged (${err.message}). Fix or remove it; it will not be overwritten.`);
    }
  }

  /** Task numbers from `docs/tasks`, computed from the files. */
  tasks(): TaskStats {
    return summarizeTasks(this.workspace);
  }

  render(state: PipelineState): string {
    return renderStateMd(state, this.tasks());
  }

  /** Applies operations (creating the state first if there is none) and writes both files. All or nothing. */
  apply(ops: unknown): { ok: true; state: PipelineState } | { ok: false; error: string } {
    let current: PipelineState | undefined;
    try {
      current = this.load();
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
    const result = applyOps(current ?? newState(this.now()), ops, {
      now: this.now(),
      inspectFile: (rel) => {
        try {
          const file = path.resolve(this.workspace, rel);
          const data = fs.readFileSync(file);
          return { hash: crypto.createHash('sha256').update(data).digest('hex'), size: data.length };
        } catch {
          return undefined;
        }
      },
    });
    if (!result.ok) return result;
    const state = normalizeState(result.state);
    this.write(state);
    return { ok: true, state };
  }

  /**
   * Writes both files. The state goes through `normalizeState` first, so the file's layout is always
   * the same (a committed state.json does not reshuffle between writes).
   */
  write(state: PipelineState): void {
    const canonical = normalizeState(state);
    writeAtomic(this.statePath, JSON.stringify(canonical, null, 2) + '\n');
    writeAtomic(this.markdownPath, this.render(canonical));
  }
}
