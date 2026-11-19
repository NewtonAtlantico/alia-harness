import fs from 'node:fs';
import path from 'node:path';
import { documentKind, readDocument } from '../documents/readDocument.js';
import { InputKind, PipelineInput, PipelineStateStore } from './pipelineState.js';

/**
 * The first step of the pipeline: what the user gave it, what each file is, which skill will read it, and what cannot be read
 * at all. Nothing here starts a run; `planPipelineInputs` only decides, and `recordPipelineInputs` writes the inventory.
 */

export const SKILL_DOCUMENTS = 'requirement-extraction-from-documents';
export const SKILL_THREADS = 'requirement-extraction-from-threads';
export const SKILL_BRIEF = 'ticket-to-brief';

/** A text file this small is a request ("add a login page"), not a document. */
export const SHORT_REQUEST_BYTES = 1500;

export type InputClass = 'document' | 'transcript' | 'request' | 'recording' | 'legacy' | 'unsupported' | 'missing';

export interface IntakeItem {
  path: string;
  name: string;
  size: number;
  class: InputClass;
  /** The kind recorded in the pipeline's inventory. */
  kind: InputKind;
  /** The skill that will read it (none for a recording, which cannot be read). */
  handledBy?: string;
  /** A recording is only usable through a transcript the user attaches. */
  needsTranscript: boolean;
  /** Why it cannot be used, in the reader's own words. Absent when the file is fine. */
  problem?: string;
  /** Things worth knowing about a readable file (pages without text, and so on). */
  warnings: string[];
}

const TRANSCRIPT_EXTENSIONS = new Set(['.vtt', '.srt', '.eml']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.text']);
const TRANSCRIPT_NAME = /transcri|\bata\b|meeting|reuni|\bchat\b|thread|e-?mail|conversa/i;

/**
 * What a file is, from its extension and size alone (nothing is read). A readable-or-not verdict for documents needs
 * `inspectInput`, which also opens them.
 */
export function classifyInput(file: string): IntakeItem {
  const name = path.basename(file);
  const ext = path.extname(file).toLowerCase();
  const base = { path: file, name, size: 0, needsTranscript: false, warnings: [] as string[] };

  let stat: fs.Stats | undefined;
  try {
    stat = fs.statSync(file);
  } catch {
    /* handled below */
  }
  if (!stat) return { ...base, class: 'missing', kind: 'other', problem: `"${name}" was not found.` };
  if (!stat.isFile()) return { ...base, class: 'unsupported', kind: 'other', problem: `"${name}" is not a file.` };
  const size = stat.size;

  const kind = documentKind(file);
  if (kind === 'recording') return { ...base, size, class: 'recording', kind: 'recording', needsTranscript: true };
  if (kind === 'legacy') return { ...base, size, class: 'legacy', kind: 'document' };
  if (kind) return { ...base, size, class: 'document', kind: 'document', handledBy: SKILL_DOCUMENTS };

  if (TRANSCRIPT_EXTENSIONS.has(ext)) return { ...base, size, class: 'transcript', kind: 'transcript', handledBy: SKILL_THREADS };
  if (TEXT_EXTENSIONS.has(ext)) {
    if (size <= SHORT_REQUEST_BYTES) return { ...base, size, class: 'request', kind: 'brief', handledBy: SKILL_BRIEF };
    if (TRANSCRIPT_NAME.test(name)) return { ...base, size, class: 'transcript', kind: 'transcript', handledBy: SKILL_THREADS };
    return { ...base, size, class: 'document', kind: 'document', handledBy: SKILL_DOCUMENTS };
  }
  return { ...base, size, class: 'unsupported', kind: 'other', problem: `"${name}" is not a supported document type.` };
}

/** `classifyInput`, plus opening the file with `readDocument` so that what cannot be read is explained in its own words. */
export async function inspectInput(file: string): Promise<IntakeItem> {
  const item = classifyInput(file);
  if (item.class === 'document' && documentKind(file)) {
    // A few thousand characters are enough to know a scan from a document (it reads until the budget is spent).
    const read = await readDocument(file, { maxChars: 4000 });
    if (!read.ok) return { ...item, handledBy: undefined, problem: read.error };
    return { ...item, warnings: read.warnings };
  }
  if (item.class === 'legacy' || item.class === 'recording') {
    const read = await readDocument(file);
    return { ...item, ...(read.ok ? {} : { problem: read.error }) };
  }
  if ((item.class === 'transcript' || item.class === 'request' || item.class === 'document') && item.size === 0) {
    return { ...item, handledBy: undefined, problem: `"${item.name}" is empty.` };
  }
  return item;
}

/** A file to start the pipeline with. A recording comes with the transcript that stands for it. */
export interface PipelineStartInput {
  path: string;
  /** For a recording: the transcript file attached in its place. */
  transcriptPath?: string;
}

export interface IntakeProblem {
  path: string;
  name: string;
  message: string;
}

export interface IntakePlan {
  /** What goes into the inventory, in the order the user gave. */
  entries: Array<{ item: IntakeItem; notes?: string }>;
  problems: IntakeProblem[];
}

/**
 * Decides whether these files can start a pipeline: every one must exist and be readable, and a recording must come with a
 * transcript that is itself readable. Nothing is written.
 */
export async function planPipelineInputs(inputs: PipelineStartInput[]): Promise<IntakePlan> {
  const entries: IntakePlan['entries'] = [];
  const problems: IntakeProblem[] = [];
  const seen = new Set<string>();
  const add = (item: IntakeItem, notes?: string) => {
    const key = path.resolve(item.path).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ item, ...(notes ? { notes } : {}) });
  };

  if (inputs.length === 0) problems.push({ path: '', name: '', message: 'Add at least one file or a request to start the pipeline.' });

  for (const input of inputs) {
    const item = await inspectInput(input.path);
    if (item.problem && item.class !== 'recording') {
      problems.push({ path: item.path, name: item.name, message: item.problem });
      continue;
    }
    if (item.class === 'recording') {
      if (!input.transcriptPath) {
        problems.push({ path: item.path, name: item.name, message: item.problem ?? `"${item.name}" is a recording and cannot be read. Attach its transcript.` });
        continue;
      }
      const transcript = await inspectInput(input.transcriptPath);
      if (transcript.problem || transcript.class === 'recording') {
        problems.push({ path: transcript.path, name: transcript.name, message: transcript.problem ?? `"${transcript.name}" is a recording, not a transcript.` });
        continue;
      }
      add({ ...item, problem: undefined }, `Not read: audio/video. Its transcript, ${transcript.name}, stands in for it.`);
      add({ ...transcript, kind: 'transcript', handledBy: SKILL_THREADS }, `Transcript of ${item.name}.`);
      continue;
    }
    add(item);
  }
  return { entries, problems };
}

/** Where a file is recorded in `state.json`: relative to the project when it is inside it, absolute otherwise. */
export function inventoryPath(workspace: string, file: string): string {
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(workspace), abs);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : abs;
}

/**
 * Writes the input inventory (names, kinds, which skill reads each, and the hash of each file) to the project's
 * `state.json` **before anything runs**, so a later change to a file is noticed and a resume knows what it started with.
 * Adding to an existing state replaces an input of the same name and keeps everything else.
 */
export function recordPipelineInputs(workspace: string, plan: IntakePlan, options: { project?: string } = {}): { ok: true; inputs: PipelineInput[] } | { ok: false; error: string } {
  const store = new PipelineStateStore(workspace);
  let existing;
  try {
    existing = store.load();
  } catch (err: any) {
    return { ok: false, error: err.message };
  }
  const ops: Array<Record<string, unknown>> = [];
  const project = options.project ?? path.basename(path.resolve(workspace));
  if (!existing?.project && project) ops.push({ op: 'set_project', name: project });
  for (const { item, notes } of plan.entries) {
    ops.push({
      op: 'add_input',
      name: item.name,
      input_kind: item.kind,
      ...(item.handledBy ? { handled_by: item.handledBy } : {}),
      ...(notes ? { notes } : {}),
      path: inventoryPath(workspace, item.path),
    });
  }
  const result = store.apply(ops);
  if (!result.ok) return { ok: false, error: result.error };
  const names = new Set(plan.entries.map((e) => e.item.name.toLowerCase()));
  return { ok: true, inputs: result.state.inputs.filter((i) => names.has(i.name.toLowerCase())) };
}

/** The text that opens the pipeline: what was given, which skill reads each, and what to do about an existing state. */
export function describePipelineStart(workspace: string, inputs: PipelineInput[], resuming: boolean): string {
  const lines = inputs.map((i) => {
    const where = i.path ?? i.name;
    const how = i.handledBy ? `read with ${i.handledBy}` : i.kind === 'recording' ? 'a recording, not read: use its transcript' : 'record it';
    return `- ${where} (${i.kind}; ${how})${i.notes ? ` — ${i.notes}` : ''}`;
  });
  return [
    resuming
      ? 'A pipeline already exists for this project. These inputs were added to its inventory in docs/pipeline/state.json. Resume from the state, taking them into account.'
      : 'Start the pipeline for this project. The inputs are already inventoried in docs/pipeline/state.json (do not add them again).',
    '',
    'Inputs:',
    ...lines,
    '',
    `Project folder: ${path.resolve(workspace)}`,
  ].join('\n');
}
