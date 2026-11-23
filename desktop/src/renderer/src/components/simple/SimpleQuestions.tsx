import { useEffect, useId, useMemo, useState } from 'react';
import type { PipelineView } from '../../../../shared/ipc';
import { useFileText } from '../../hooks/useFileText';
import { t } from '../../i18n/pt-BR';
import { PICK_LATER, PICK_OWNER, answerOf, isAnswered, pickOfSettled, settledLine, simpleQuestion, whyText, type Pick, type Picks, type SimpleOption } from '../../lib/simpleQuestions';
import { understoodFrom } from '../../lib/specText';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * The questions of a gate, one at a time: what the files say when they disagree, the choices in plain words, and two ways out
 * ("Não sei: perguntar a outra pessoa", "Decidir depois"). Each answer is recorded when the person goes on, in their name, so
 * closing the app loses nothing. The last answer approves the gate (the person's decision) and lets the work go on.
 */
export function SimpleQuestions({
  view,
  sessionId,
  gate,
  me,
  owner,
  onChanged,
  onResume,
  onOpenFile,
}: {
  view: PipelineView;
  sessionId: string;
  gate: 'G1' | 'G3';
  /** The person: owner of what they leave for later, and who the answers are recorded as. */
  me: string;
  /** Who answers the technical questions. */
  owner: string;
  onChanged: () => Promise<void> | void;
  onResume: () => Promise<void>;
  onOpenFile: (path: string) => void;
}) {
  const questions = useMemo(() => (view.state?.gates.find((g) => g.id === gate)?.questions ?? []).map(simpleQuestion), [view, gate]);
  const firstOpen = questions.findIndex((q) => q.status === 'open');
  const [index, setIndex] = useState(Math.max(0, firstOpen));
  const [picks, setPicks] = useState<Picks>({});
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string>();
  const groupId = useId();
  const who = { me, owner: owner.trim() || t.simple.newScreen.ownerLabel };
  const by = me.trim() || 'Usuário';

  // A new gate starts at its first open question.
  useEffect(() => {
    setIndex(Math.max(0, questions.findIndex((q) => q.status === 'open')));
    setPicks({});
  }, [gate]);

  const requirements = view.artifacts.find((a) => a.stage === 1 && a.exists && !a.isDir)?.path;
  const text = useFileText(sessionId, gate === 'G1' ? requirements : undefined, view.state?.updatedAt);
  const understood = text.state === 'ready' ? understoodFrom(text.text) : [];

  const q = questions[Math.min(index, questions.length - 1)];
  if (!q) return null;
  const locked = q.status !== 'open';
  const pick: Pick | undefined = locked ? pickOfSettled(q, who) : picks[q.id];
  const settled = questions.filter((x) => x.status !== 'open');
  const lastOpen = !questions.some((x, i) => i > index && x.status === 'open');
  const set = (patch: Pick) => setPicks((cur) => ({ ...cur, [q.id]: { ...cur[q.id], ...patch } }));

  const go = async () => {
    setError(undefined);
    if (locked) return setIndex((i) => Math.min(i + 1, questions.length - 1));
    const answer = answerOf(q, pick, who);
    if (!answer) return;
    setWorking(true);
    try {
      await window.alia.request('pipeline.answer', { sessionId, gate, answers: [answer], by });
      setPicks((cur) => {
        const { [q.id]: _done, ...rest } = cur;
        return rest;
      });
      if (!lastOpen) {
        const nextOpen = questions.findIndex((x, i) => i > index && x.status === 'open');
        setIndex(nextOpen);
        await onChanged();
        return;
      }
      // Every question is settled: at gate 1 the person's go-ahead is the approval (given before the screen is drawn again, so it
      // never shows "Tudo respondido" in between); the gaps of gate 3 lead on to the features.
      if (gate === 'G1') {
        await window.alia.request('pipeline.approveGate', { sessionId, gate });
        await onChanged();
        await onResume();
      } else await onChanged();
    } catch (err) {
      setError(t.simple.questions.failed(errorText(err)));
    } finally {
      setWorking(false);
    }
  };

  const total = questions.length;
  const position = index + 1;
  const sendLabel = gate === 'G1' ? t.simple.questions.send : t.simple.questions.sendGaps;
  const files = view.state?.inputs.length ?? 0;

  const choose = (option: string) => !locked && set({ option });
  const ways: SimpleOption[] = [
    { id: PICK_OWNER, label: t.simple.questions.unknown, detail: t.simple.questions.unknownHint },
    { id: PICK_LATER, label: t.simple.questions.later, detail: t.simple.questions.laterHint },
  ];

  return (
    <section className="simple-questions" aria-labelledby="questions-title" aria-busy={working} data-testid="simple-questions">
      <h2 id="questions-title" className="simple-heading">
        {t.simple.questions.title}
      </h2>
      <p className="lead">{gate === 'G1' ? t.simple.questions.intro(files) : t.simple.questions.introGaps}</p>

      {understood.length > 0 && (
        <div className="card understood" data-testid="simple-understood">
          <h3>{t.simple.questions.understood}</h3>
          <ul className="tick-list">
            {understood.map((u) => (
              <li key={u}>
                <span className="mark" aria-hidden="true">
                  ✓
                </span>{' '}
                {u}
              </li>
            ))}
          </ul>
          {requirements && (
            <button type="button" className="link-btn" onClick={() => onOpenFile(requirements)}>
              {t.simple.questions.fullSummary}
            </button>
          )}
        </div>
      )}

      <div className="card question-card" data-testid="simple-question" data-question={q.id}>
        <div className="question-head">
          <span className="progress-text" aria-label={t.simple.questions.progressLabel(position, total)}>
            {t.simple.questions.progress(position, total)}
          </span>
          <span className="progress-dots" aria-hidden="true">
            {questions.map((x, i) => (
              <span key={x.id} className={i < position ? 'on' : ''} />
            ))}
          </span>
          <span className="grow" />
          {q.category && <span className={`chip small ${q.contradiction ? 'cat-contradiction' : 'cat-low_confidence'}`}>{q.category}</span>}
        </div>

        <fieldset className="choices" aria-describedby={locked ? `${groupId}-locked` : undefined} disabled={working}>
          <legend className="question-prompt">{q.prompt}</legend>

          {q.sources.length > 0 && (
            <div className="source-cards" data-testid="simple-sources">
              {q.sources.map((s) => (
                <figure key={s.source} className="source-card">
                  <figcaption>{t.simple.questions.source(s.source)}</figcaption>
                  <blockquote>{s.text}</blockquote>
                </figure>
              ))}
            </div>
          )}

          {q.sources.length > 0 && <p className="choices-label">{t.simple.questions.which}</p>}

          {q.kind === 'text' ? (
            <label className="field">
              <span>{t.simple.questions.textLabel}</span>
              <textarea rows={3} value={pick?.text ?? ''} readOnly={locked} placeholder={t.simple.questions.textPlaceholder} data-testid="simple-text" onChange={(e) => set({ text: e.target.value, option: pick?.option === PICK_OWNER || pick?.option === PICK_LATER ? undefined : pick?.option })} />
            </label>
          ) : (
            q.options.map((o) => <Choice key={o.id} name={groupId} option={o} checked={pick?.option === o.id} locked={locked} onChoose={() => choose(o.id)} />)
          )}
          {ways.map((o) => (
            <Choice key={o.id} name={groupId} option={o} checked={pick?.option === o.id} locked={locked} onChoose={() => choose(o.id)} />
          ))}
        </fieldset>

        <details className="why">
          <summary>{t.simple.questions.why}</summary>
          <p>{whyText(q)}</p>
        </details>

        {locked && (
          <p id={`${groupId}-locked`} className="hint">
            {t.simple.questions.locked}
          </p>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}

        <div className="question-foot">
          <span className="hint">{t.simple.questions.signed}</span>
          <span className="grow" />
          <button type="button" className="btn" disabled={working || index === 0} onClick={() => setIndex((i) => Math.max(0, i - 1))}>
            {t.simple.questions.back}
          </button>
          <button type="button" className="btn primary" disabled={working || (locked ? index >= total - 1 : !isAnswered(q, pick))} data-testid="simple-next" onClick={() => void go()}>
            {working ? t.simple.questions.sending : !locked && lastOpen ? sendLabel : t.simple.questions.next}
          </button>
        </div>
      </div>

      {settled.length > 0 && (
        <div className="card answered" data-testid="simple-answered">
          <h3>{t.simple.questions.answered(settled.length)}</h3>
          <ul aria-label={t.simple.questions.answeredList}>
            {settled.map((s) => (
              <li key={s.id} data-question={s.id}>
                <span className="q">{s.prompt}</span>
                <span className="a">{settledLine(s, me)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="hint centered">{t.simple.questions.closeLater}</p>
    </section>
  );
}

/** One way to answer: a card with a radio button, the answer in bold and a line under it. */
function Choice({ name, option, checked, locked, onChoose }: { name: string; option: SimpleOption; checked: boolean; locked: boolean; onChoose: () => void }) {
  return (
    <label className={`choice ${checked ? 'selected' : ''}`}>
      <input type="radio" name={name} value={option.id} checked={checked} readOnly={locked} onChange={onChoose} />
      <span>
        <strong>{option.label}</strong>
        {option.detail && <span className="hint">{option.detail}</span>}
      </span>
    </label>
  );
}
