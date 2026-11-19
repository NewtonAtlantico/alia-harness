import { useId, useState, type ReactNode } from 'react';
import type { UserAnswer, UserQuestion } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { OTHER, answeredCount, buildAnswers, needsOwner, type Forms, type QuestionForm, type QuestionInteraction } from '../lib/interactions';

/**
 * The generic card for the model's questions (`ask_user`): choices with their sources, free text, yes/no, "other", and
 * "adiar" (carry it as an assumption, with an owner). Answers may be partial ("Responder depois"): what is filled in goes
 * back, the rest stays open and the agent stops at that point. The pipeline's gate card (A12) draws the same questions
 * its own way; this one serves the chat.
 */
export function QuestionCard({ interaction, queued, defaultOwner, onAnswer }: { interaction: QuestionInteraction; queued: number; defaultOwner: string; onAnswer: (answers: UserAnswer[]) => void }) {
  const titleId = useId();
  const [forms, setForms] = useState<Forms>({});
  const [showErrors, setShowErrors] = useState(false);
  const { questions } = interaction;

  const set = (id: string, patch: Partial<QuestionForm>) => setForms((cur) => ({ ...cur, [id]: { ...cur[id], ...patch } }));
  const done = answeredCount(questions, forms, defaultOwner);
  const missingOwner = needsOwner(questions, forms, defaultOwner);

  const send = () => {
    if (missingOwner.length > 0) return setShowErrors(true);
    onAnswer(buildAnswers(questions, forms, defaultOwner));
  };

  return (
    <section className="interaction-card questions" role="group" aria-labelledby={titleId} data-testid="interaction-card" data-kind="ask_user">
      <span className="sr-only" role="alert">
        {t.approval.questionsTitle}
      </span>
      <h2 id={titleId}>{t.approval.questionsTitle}</h2>
      <QuestionFields questions={questions} forms={forms} set={set} defaultOwner={defaultOwner} missingOwner={showErrors ? missingOwner : []} />
      <div className="actions">
        <button type="button" className="btn primary" onClick={send} disabled={done === 0}>
          {done < questions.length && done > 0 ? t.approval.answerCount(done, questions.length) : t.approval.answer}
        </button>
        <button type="button" className="btn" onClick={() => onAnswer(done === 0 ? [] : buildAnswers(questions, forms, defaultOwner))} title={t.approval.laterHint}>
          {t.approval.later}
        </button>
      </div>
      <p className="hint">{t.approval.laterHint}</p>
      {queued > 0 && <p className="hint">{t.approval.queued(queued)}</p>}
    </section>
  );
}

/**
 * The questions of a form, one fieldset each: choices with their detail and source, free text, yes/no, "other" and "adiar".
 * Used by the chat's card and by the pipeline's gate card, which add a badge (the category) and a note (what blank means).
 */
export function QuestionFields({
  questions,
  forms,
  set,
  defaultOwner,
  missingOwner,
  badge,
  note,
}: {
  questions: UserQuestion[];
  forms: Forms;
  set: (id: string, patch: Partial<QuestionForm>) => void;
  defaultOwner: string;
  /** Question ids whose deferral still needs an owner (shown as an error). */
  missingOwner: string[];
  badge?: (q: UserQuestion) => ReactNode;
  note?: (q: UserQuestion) => ReactNode;
}) {
  const groupId = useId();
  return (
    <>
      {questions.map((q, n) => {
        const f = forms[q.id] ?? {};
        const name = `${groupId}-${q.id}`;
        return (
          <fieldset key={q.id} className="question" data-question={q.id}>
            <legend>
              {questions.length > 1 ? `${n + 1}. ` : ''}
              {q.prompt}
              {badge?.(q)}
              {q.confidence && <span className={`chip small conf-${q.confidence}`}>{t.approval.confidence[q.confidence]}</span>}
            </legend>

            {q.kind === 'choice' && (
              <div className="options" role="radiogroup" aria-label={q.prompt}>
                {q.options?.map((o) => (
                  <label key={o.id} className={`option ${f.choice === o.id && !f.deferred ? 'selected' : ''}`}>
                    <input type="radio" name={name} checked={f.choice === o.id && !f.deferred} disabled={f.deferred} onChange={() => set(q.id, { choice: o.id })} />
                    <span>
                      <strong>{o.label}</strong>
                      {o.detail && <span className="hint">{o.detail}</span>}
                      {o.source && <span className="hint source">{t.approval.source(o.source)}</span>}
                    </span>
                  </label>
                ))}
                {q.allowOther && (
                  <label className={`option ${f.choice === OTHER && !f.deferred ? 'selected' : ''}`}>
                    <input type="radio" name={name} checked={f.choice === OTHER && !f.deferred} disabled={f.deferred} onChange={() => set(q.id, { choice: OTHER })} />
                    <span>
                      <strong>{t.approval.other}</strong>
                      <input type="text" aria-label={t.approval.otherPlaceholder} placeholder={t.approval.otherPlaceholder} value={f.other ?? ''} disabled={f.deferred} onFocus={() => set(q.id, { choice: OTHER })} onChange={(e) => set(q.id, { choice: OTHER, other: e.target.value })} />
                    </span>
                  </label>
                )}
              </div>
            )}

            {q.kind === 'text' && <textarea rows={2} aria-label={q.prompt} placeholder={t.approval.textPlaceholder} value={f.text ?? ''} disabled={f.deferred} onChange={(e) => set(q.id, { text: e.target.value })} />}

            {q.kind === 'confirm' && (
              <div className="options row" role="radiogroup" aria-label={q.prompt}>
                <label className={`option ${f.confirm === true && !f.deferred ? 'selected' : ''}`}>
                  <input type="radio" name={name} checked={f.confirm === true && !f.deferred} disabled={f.deferred} onChange={() => set(q.id, { confirm: true })} />
                  <strong>{t.approval.yes}</strong>
                </label>
                <label className={`option ${f.confirm === false && !f.deferred ? 'selected' : ''}`}>
                  <input type="radio" name={name} checked={f.confirm === false && !f.deferred} disabled={f.deferred} onChange={() => set(q.id, { confirm: false })} />
                  <strong>{t.approval.no}</strong>
                </label>
              </div>
            )}

            {q.allowDefer && <DeferRow q={q} form={f} defaultOwner={defaultOwner} onChange={(patch) => set(q.id, patch)} error={missingOwner.includes(q.id)} />}
            {note?.(q)}
          </fieldset>
        );
      })}
    </>
  );
}

function DeferRow({ q, form, defaultOwner, onChange, error }: { q: UserQuestion; form: QuestionForm; defaultOwner: string; onChange: (patch: Partial<QuestionForm>) => void; error: boolean }) {
  return (
    <div className="defer">
      <label>
        <input type="checkbox" checked={!!form.deferred} onChange={(e) => onChange({ deferred: e.target.checked })} /> {t.approval.defer}
      </label>
      {form.deferred && (
        <label className="owner">
          <span className="hint">{t.approval.owner}</span>
          <input type="text" value={form.owner ?? defaultOwner} onChange={(e) => onChange({ owner: e.target.value })} aria-label={`${t.approval.owner}: ${q.prompt}`} aria-invalid={error} />
          {error && (
            <span className="error" role="alert">
              {t.approval.needOwner}
            </span>
          )}
        </label>
      )}
    </div>
  );
}
