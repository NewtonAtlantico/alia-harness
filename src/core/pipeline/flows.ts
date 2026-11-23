/**
 * A flow: the skills and the steps the end-to-end pipeline runs for one kind of project. The pipeline itself (the state file, the
 * gates, the review of the specs) is the same for every flow; the flow says which skill does each stage, where its artifact goes,
 * which skill reads each kind of input, and how each step is called, for people who read the code and for people who do not.
 *
 * Adding a flow is adding an entry to `FLOWS`: the intake, the run, the resume and both screens of the app follow from it.
 */

/** The stage numbers and the gates after them. The shape is fixed (four stages, three gates); what runs in them is the flow's. */
export type FlowStageNumber = 1 | 2 | 3 | 4;
export type FlowGateId = 'G1' | 'G2' | 'G3';

export interface FlowStage {
  stage: FlowStageNumber;
  /** A short id: `requirements`, `architecture`, `specs`, `tasks`. */
  key: string;
  /** The skill that does the stage. */
  skill: string;
  /** Where the stage writes, relative to the project (a folder ends with `/`). */
  artifact: string;
  /** The gate that follows the stage, when there is one. */
  gate?: FlowGateId;
  /** The step as a person who reads the technical view calls it ("Requisitos"). */
  label: string;
  /** The step in the words of the simple view, for someone who is not technical. */
  simple: {
    title: string;
    description: string;
    /** Whether the person using the simple view takes part in this step (answers, confirms). When not, the technical owner does. */
    participates: boolean;
  };
}

export interface PipelineFlow {
  /** Stable id, stored in the project's state (`embrapii`). */
  id: string;
  /** What the person picks in the list ("Embrapii"). */
  name: string;
  /** One line about what the flow is for. */
  description: string;
  /** The skill that orchestrates the stages (the pipeline skill). */
  orchestrator: string;
  stages: ReadonlyArray<FlowStage>;
  /** Which skill reads each kind of input at the first stage. */
  intake: { documents: string; threads: string; brief: string };
}

/** The flow the pipeline has always run: documents to requirements, architecture, specs and estimated tasks. */
export const EMBRAPII_FLOW: PipelineFlow = {
  id: 'embrapii',
  name: 'Embrapii',
  description: 'Da documentação do cliente ao backlog estimado: requisitos, arquitetura, specs e tarefas.',
  orchestrator: 'requirements-to-tasks-pipeline',
  stages: [
    {
      stage: 1,
      key: 'requirements',
      skill: 'requirement-extraction-from-documents',
      artifact: 'docs/requirements/requirements.md',
      gate: 'G1',
      label: 'Requisitos',
      simple: { title: 'Entender o pedido', description: 'Você responde dúvidas sobre o que foi pedido.', participates: true },
    },
    {
      stage: 2,
      key: 'architecture',
      skill: 'architecture-from-requirements',
      artifact: 'docs/architecture/architecture.md',
      gate: 'G2',
      label: 'Arquitetura',
      simple: { title: 'Desenhar a solução', description: 'O responsável técnico decide. Você só acompanha.', participates: false },
    },
    {
      stage: 3,
      key: 'specs',
      skill: 'constitution-to-specs',
      artifact: 'docs/specs/INDEX.md',
      gate: 'G3',
      label: 'Specs',
      simple: { title: 'Detalhar as funcionalidades', description: 'Você confirma se entendemos certo.', participates: true },
    },
    {
      stage: 4,
      key: 'tasks',
      skill: 'spec-to-tasks',
      artifact: 'docs/tasks/',
      label: 'Tarefas',
      simple: { title: 'Planejar as entregas', description: 'Você recebe o plano e envia ao time técnico.', participates: false },
    },
  ],
  intake: {
    documents: 'requirement-extraction-from-documents',
    threads: 'requirement-extraction-from-threads',
    brief: 'ticket-to-brief',
  },
};

/** Every flow the app offers, the first being the default. */
export const FLOWS: ReadonlyArray<PipelineFlow> = [EMBRAPII_FLOW];

export const DEFAULT_FLOW_ID = EMBRAPII_FLOW.id;

/** The flow with this id; the default flow for no id, and `undefined` for an id that no flow has. */
export function findFlow(id?: string): PipelineFlow | undefined {
  if (id === undefined || id === '') return FLOWS.find((f) => f.id === DEFAULT_FLOW_ID);
  return FLOWS.find((f) => f.id === id);
}

/** The flow with this id, or the default flow when there is none with it (a state written by a newer version, say). */
export function getFlow(id?: string): PipelineFlow {
  return findFlow(id) ?? EMBRAPII_FLOW;
}
