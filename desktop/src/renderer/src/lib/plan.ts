/**
 * The finished plan for someone who is not technical: how many features, tasks and points, the order the features are delivered in
 * and why, what was decided, and what is still open and with whom. It also writes the same plan as the summary people take with
 * them (a PDF, a Markdown file). The numbers come from core's report; nothing is computed twice. No React, no DOM.
 */
import type { PipelineView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

export interface PlanFeature {
  /** Its place in the order of delivery, from 1. */
  n: number;
  slug: string;
  title: string;
  /** "Base para todas as outras", "Depois da 1 e da 2". */
  note: string;
  points: number;
  tasks: number;
  /** Its points as a share of the largest feature's, for the little bar. */
  share: number;
}

export interface PlanPending {
  text: string;
  who: string;
  /** The step of the flow it came from, in the words of the simple view. */
  step: string;
}

export interface PlanData {
  features: number;
  tasks: number;
  points: number;
  order: PlanFeature[];
  decisions: string[];
  pending: PlanPending[];
  /** Things that still hold the plan back (an open question, a spec nobody reviewed, a failed check). */
  blockers: number;
}

/** "1", "1 e 2", "1, 2 e 3". */
export function joinRefs(refs: string[]): string {
  if (refs.length <= 1) return refs.join('');
  return `${refs.slice(0, -1).join(', ')} e ${refs[refs.length - 1]}`;
}

/** Puts the features in an order where each comes after the ones it depends on, keeping the given order otherwise. */
export function deliveryOrder<T extends { slug: string; dependsOn: string[] }>(items: T[]): T[] {
  const known = new Set(items.map((i) => i.slug));
  const placed: T[] = [];
  const done = new Set<string>();
  let rest = [...items];
  while (rest.length > 0) {
    const ready = rest.find((i) => i.dependsOn.filter((d) => known.has(d) && d !== i.slug).every((d) => done.has(d)));
    // A cycle has no order: what is left goes as it came (the report already says that a cycle blocks).
    const pick = ready ?? rest[0];
    placed.push(pick);
    done.add(pick.slug);
    rest = rest.filter((i) => i !== pick);
  }
  return placed;
}

/** How a decision reads: its answer when that is a sentence, the question with the answer when it is a word. */
function decisionLine(d: { question: string; answer: string }): string {
  const answer = d.answer.trim();
  if (answer.split(/\s+/).length >= 4 || !d.question.trim()) return answer;
  return `${d.question.trim()} ${answer}`;
}

export function planFor(view: PipelineView): PlanData | null {
  const { state, report, flow } = view;
  if (!state || !report) return null;
  const ordered = deliveryOrder(report.backlog.map((b) => ({ ...b, dependsOn: b.dependsOn })));
  const index = new Map(ordered.map((b, i) => [b.slug, i + 1]));
  const biggest = Math.max(1, ...ordered.map((b) => b.points));
  // A feature everything else leans on, directly or through another.
  const leansOn = (slug: string, on: string, seen = new Set<string>()): boolean => {
    const deps = ordered.find((o) => o.slug === slug)?.dependsOn ?? [];
    return deps.some((d) => d === on || (!seen.has(d) && (seen.add(d), leansOn(d, on, seen))));
  };
  const order: PlanFeature[] = ordered.map((b, i) => {
    const deps = b.dependsOn.map((d) => index.get(d)).filter((n): n is number => !!n).sort((a, z) => a - z);
    const base = deps.length === 0 && ordered.length > 1 && ordered.every((o) => o.slug === b.slug || leansOn(o.slug, b.slug));
    const note = deps.length > 0 ? t.simple.plan.after(joinRefs(deps.map((n) => `da ${n}`))) : base ? t.simple.plan.baseFor : t.simple.plan.anytime;
    return { n: i + 1, slug: b.slug, title: b.title, note, points: b.points, tasks: b.taskCount, share: b.points / biggest };
  });

  const answered = state.gates.flatMap((g) => g.questions).filter((q) => q.status === 'answered');
  const decisions = (state.decisions.length > 0 ? state.decisions.map(decisionLine) : answered.map((q) => decisionLine({ question: q.prompt, answer: q.answerLabel ?? q.answer ?? '' }))).filter(Boolean);

  const stepTitle = (stage?: number) => (stage ? (flow?.stages.find((s) => s.stage === stage)?.simple.title ?? '') : '');
  return {
    features: report.specs,
    tasks: report.tasks,
    points: report.points,
    order,
    decisions,
    pending: state.assumptions.map((a) => ({ text: a.text, who: a.owner, step: stepTitle(a.stage) })),
    blockers: report.blockers.length,
  };
}

// ------------------------------------------------------------------------------------ the summary people take with them

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The summary as Markdown, for the file whose link is copied. */
export function planMarkdown(plan: PlanData, project: string, flow?: string): string {
  const s = t.simple;
  const lines = [`# ${s.summary.title(project)}`, ''];
  if (flow) lines.push(`${s.summary.client}: ${flow}`, '');
  lines.push(s.summary.totals(plan.features, plan.tasks, plan.points), '', `## ${s.plan.order}`, '');
  for (const f of plan.order) lines.push(`${f.n}. **${f.title}** — ${f.note}. ${s.plan.pointsAndTasks(f.points, f.tasks)}`);
  lines.push('', `## ${s.plan.decisions}`, '');
  lines.push(...(plan.decisions.length > 0 ? plan.decisions.map((d) => `- ${d}`) : [s.plan.noDecisions]));
  lines.push('', `## ${s.plan.pending}`, '');
  lines.push(...(plan.pending.length > 0 ? plan.pending.map((p) => `- ${p.text} (${s.plan.pendingOwner(p.who, p.step)})`) : [s.plan.noPending]));
  return `${lines.join('\n')}\n`;
}

/** The summary as a page to print (A4), with its own small stylesheet: it is drawn in a window that loads nothing else. */
export function planHtml(plan: PlanData, project: string, flow?: string): string {
  const s = t.simple;
  const list = (items: string[]) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`;
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(s.summary.title(project))}</title><style>
    body{font-family:Segoe UI,Arial,sans-serif;color:#1f2937;margin:32px;font-size:13px;line-height:1.5}
    h1{font-size:22px;margin:0 0 4px;color:#26409a}h2{font-size:15px;margin:24px 0 8px;border-bottom:1px solid #dfe3ea;padding-bottom:4px}
    .muted{color:#5b6472}.totals{font-size:15px;margin:8px 0}ol,ul{padding-left:20px;margin:0}li{margin:4px 0}
    .note{color:#5b6472}.who{color:#5b6472}
  </style></head><body>
    <h1>${esc(s.summary.title(project))}</h1>
    ${flow ? `<p class="muted">${esc(s.summary.client)}: ${esc(flow)}</p>` : ''}
    <p class="totals">${esc(s.summary.totals(plan.features, plan.tasks, plan.points))}</p>
    <h2>${esc(s.plan.order)}</h2>
    <ol>${plan.order.map((f) => `<li><strong>${esc(f.title)}</strong> <span class="note">· ${esc(f.note)} · ${esc(s.plan.pointsAndTasks(f.points, f.tasks))}</span></li>`).join('')}</ol>
    <h2>${esc(s.plan.decisions)}</h2>${plan.decisions.length > 0 ? list(plan.decisions) : `<p class="muted">${esc(s.plan.noDecisions)}</p>`}
    <h2>${esc(s.plan.pending)}</h2>${plan.pending.length > 0 ? `<ul>${plan.pending.map((p) => `<li>${esc(p.text)} <span class="who">· ${esc(s.plan.pendingOwner(p.who, p.step))}</span></li>`).join('')}</ul>` : `<p class="muted">${esc(s.plan.noPending)}</p>`}
  </body></html>`;
}
