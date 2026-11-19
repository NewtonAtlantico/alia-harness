import { useId, useState } from 'react';
import type { UserAnswer } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { needsOwner, type Forms, type QuestionForm } from '../lib/interactions';
import { categoryLabel, finishAnswers, isBlankText, partialAnswers, settledText, toUserQuestions, type GateCardData } from '../lib/pipelineRun';
import { QuestionFields } from './QuestionCard';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * What the pipeline waits for at a gate, drawn from its state: the questions already settled (collapsed, with who answered
 * and when), the open ones with their options, sources and categories, and, when nothing is open, only the approval.
 * The answers and the approval are the user's own and go straight into state.json; the model only continues afterwards.
 */
export function GateCard({
  card,
  sessionId,
  defaultOwner,
  onChanged,
  onResume,
  title,
  chip,
  follows = true,
}: {
  card: GateCardData;
  /** Replaces the card's title (gate 2 calls it the architecture review). */
  title?: string;
  /** A chip beside the title (the recommendation of the architecture review). */
  chip?: { label: string; tone: 'ok' | 'warn' | 'bad' };
  /** Whether answering everything also approves the gate and goes on. False at gate 3, where the specs have to be reviewed first (that screen has its own button). */
  follows?: boolean;
  sessionId: string;
  defaultOwner: string;
  /** The state changed: read it again. */
  onChanged: () => Promise<void> | void;
  /** Continue the pipeline in this conversation (after the gate was approved). */
  onResume: () => Promise<void>;
}) {
  const titleId = useId();
  const [forms, setForms] = useState<Forms>({});
  const [showErrors, setShowErrors] = useState(false);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string>();
  const [error, setError] = useState<string>();
  const by = defaultOwner.trim() || 'Usuário';
  const questions = toUserQuestions(card.open);
  const byId = new Map(card.open.map((q) => [q.id, q]));
  const set = (id: string, patch: Partial<QuestionForm>) => setForms((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  const finish = finishAnswers(questions, forms, defaultOwner);
  const goes = follows && finish.complete;
  const partial = partialAnswers(questions, forms, defaultOwner);
  const missingOwner = needsOwner(questions, forms, defaultOwner);

  const run = async (action: () => Promise<void>) => {
    setWorking(true);
    setError(undefined);
    setMessage(undefined);
    try {
      await action();
    } catch (err) {
      setError(t.run.gate.failed(errorText(err)));
    } finally {
      setWorking(false);
    }
  };

  const record = async (answers: UserAnswer[]) => {
    const r = await window.alia.request('pipeline.answer', { sessionId, gate: card.gate, answers, by });
    setForms({});
    setShowErrors(false);
    await onChanged();
    return r;
  };

  const sendAndGo = () =>
    run(async () => {
      if (missingOwner.length > 0) return void setShowErrors(true);
      await record(finish.answers);
      await window.alia.request('pipeline.approveGate', { sessionId, gate: card.gate });
      await onChanged();
      await onResume();
    });

  const sendPartial = (answers: UserAnswer[]) =>
    run(async () => {
      if (missingOwner.length > 0) return void setShowErrors(true);
      if (answers.length === 0) return;
      const r = await record(answers);
      setMessage(`${t.run.gate.saved(answers.length)}${r.progress.open > 0 ? ` ${t.run.gate.stillOpen(r.progress.open)}` : ''}`);
    });

  const approveAndGo = () =>
    run(async () => {
      await window.alia.request('pipeline.approveGate', { sessionId, gate: card.gate });
      await onChanged();
      await onResume();
    });

  return (
    <section className="interaction-card gate-card" role="group" aria-labelledby={titleId} data-testid="gate-card" data-gate={card.gate} aria-busy={working}>
      <h2 id={titleId}>
        {title ?? card.title}{' '}
        {chip && (
          <span className={`chip small rec-${chip.tone}`} data-testid="gate-chip">
            {chip.label}
          </span>
        )}{' '}
        <span className="hint">{t.run.gate.progress(card.settled.length, card.settled.length + card.open.length)}</span>
      </h2>

      {card.settled.length > 0 && (
        <details className="settled" data-testid="gate-settled">
          <summary>{t.run.gate.answered(card.settled.length)}</summary>
          <ul>
            {card.settled.map((q) => (
              <li key={q.id} data-question={q.id}>
                <span className="q">{q.prompt}</span>
                <span className="a">{settledText(q)}</span>
                {(q.by || q.date) && <span className="hint">{t.run.gate.by(q.by ?? '', q.date)}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}

      {card.open.length > 0 ? (
        <>
          <QuestionFields
            questions={questions}
            forms={forms}
            set={set}
            defaultOwner={defaultOwner}
            missingOwner={showErrors ? missingOwner : []}
            badge={(q) => {
              const label = byId.get(q.id) && categoryLabel(byId.get(q.id)!);
              return label ? <span className={`chip small cat-${byId.get(q.id)!.category}`}>{label}</span> : null;
            }}
            note={(q) => {
              const source = byId.get(q.id)?.source;
              return (
                <>
                  {source && q.kind !== 'choice' && <p className="hint source">{t.approval.source(source)}</p>}
                  {isBlankText(q, forms) && !!defaultOwner.trim() && <p className="hint">{t.run.gate.blank}</p>}
                </>
              );
            }}
          />
          <div className="actions">
            <button type="button" className="btn primary" disabled={working || (finish.complete ? false : partial.length === 0)} onClick={goes ? sendAndGo : () => sendPartial(follows || !finish.complete ? partial : finish.answers)}>
              {working ? t.run.gate.working : goes ? t.run.gate.sendAndGo : !follows && finish.complete ? t.approval.answer : t.run.gate.send(partial.length, questions.length)}
            </button>
            <button type="button" className="btn" disabled={working || partial.length === 0} onClick={() => sendPartial(partial)} title={t.run.gate.laterHint}>
              {t.run.gate.later}
            </button>
          </div>
          <p className="hint">{t.run.gate.laterHint}</p>
        </>
      ) : (
        <>
          <p>{t.run.gate.ready(card.gate)}</p>
          <div className="actions">
            <button type="button" className="btn primary" disabled={working} onClick={approveAndGo} data-testid="gate-approve">
              {working ? t.run.gate.working : t.run.gate.approveAndGo}
            </button>
          </div>
          <p className="hint">{t.run.gate.approveHint}</p>
        </>
      )}
      {message && (
        <p className="hint" role="status" data-testid="gate-message">
          {message}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

