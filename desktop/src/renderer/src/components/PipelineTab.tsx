import type { PipelineView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

/**
 * The pipeline's side of the right panel: the artifacts of each stage (open with the system), the inputs with a warning for
 * one that changed since it was registered, the assumptions with their owners, and the notes the pipeline kept.
 */
export function PipelineTab({ view, onOpen, error }: { view?: PipelineView; onOpen: (path: string) => void; error?: string }) {
  if (!view?.state) return <p className="hint panel-note">{t.run.panel.noArtifacts}</p>;
  const { state, artifacts, status } = view;
  const changed = new Set(status.staleInputs.map((i) => i.name));
  return (
    <div className="pipeline-tab" aria-label={t.run.panel.label} data-testid="pipeline-tab">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <section aria-labelledby="pt-artifacts">
        <h2 id="pt-artifacts">{t.run.panel.artifacts}</h2>
        {artifacts.every((a) => !a.exists) ? (
          <p className="hint">{t.run.panel.noArtifacts}</p>
        ) : null}
        <ul>
          {artifacts.map((a) => (
            <li key={a.path} data-artifact={a.path}>
              <span className="hint">{t.run.steps[String(a.stage)]}</span>
              {a.exists ? (
                <button type="button" className="link-btn" onClick={() => onOpen(a.path)} aria-label={t.run.panel.open(a.path)}>
                  {a.path}
                </button>
              ) : (
                <span className="muted">
                  {a.path} <span className="hint">· {t.run.panel.notYet}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="pt-inputs">
        <h2 id="pt-inputs">{t.run.panel.inputs}</h2>
        {state.inputs.length === 0 && <p className="hint">{t.run.panel.noInputs}</p>}
        <ul>
          {state.inputs.map((i) => (
            <li key={i.name} data-input={i.name}>
              <span>{i.name}</span> <span className="chip small">{i.kind}</span>
              {i.handledBy && <span className="hint"> · {i.handledBy}</span>}
              {changed.has(i.name) && <span className="chip small warn"> {t.run.panel.changedInput}</span>}
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="pt-assumptions">
        <h2 id="pt-assumptions">{t.run.panel.assumptions}</h2>
        {state.assumptions.length === 0 && <p className="hint">{t.run.panel.noAssumptions}</p>}
        <ul>
          {state.assumptions.map((a, n) => (
            <li key={`${a.text}:${n}`} data-assumption>
              {a.text} <span className="hint">· {t.run.panel.ownerOf(a.owner)}</span>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="pt-note">
        <h2 id="pt-note">{t.run.panel.note}</h2>
        {state.notes.length === 0 && <p className="hint">{t.run.panel.noNote}</p>}
        <ul>
          {state.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
