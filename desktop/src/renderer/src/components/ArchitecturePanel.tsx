import { useFileText } from '../hooks/useFileText';
import { t } from '../i18n/pt-BR';
import type { ArchitectureData } from '../lib/stagePanels';
import { Markdown } from './Markdown';

/**
 * Gate 2, "Arquitetura proposta": the style and what drove it, the bounded contexts, the ADRs with their status, how the
 * proposal lines up with the ADRs that already exist, and what goes forward as an assumption. Without a structured summary
 * (the model did not record one) it says so and shows the document itself.
 */
export function ArchitecturePanel({ data, sessionId, onOpen }: { data: ArchitectureData; sessionId: string; onOpen: (path: string) => void }) {
  const doc = useFileText(sessionId, data.summary ? undefined : data.document);
  const { summary } = data;
  return (
    <section className="stage-panel architecture" aria-labelledby="arch-title" data-testid="architecture-panel">
      <h2 id="arch-title">{t.run.arch.title}</h2>
      {summary ? (
        <>
          <dl className="facts">
            <dt>{t.run.arch.style}</dt>
            <dd data-testid="arch-style">{summary.style}</dd>
            {summary.driver && (
              <>
                <dt>{t.run.arch.driver}</dt>
                <dd>{summary.driver}</dd>
              </>
            )}
          </dl>
          {summary.contexts.length > 0 && (
            <>
              <h3>{t.run.arch.contexts}</h3>
              <ul className="contexts">
                {summary.contexts.map((c) => (
                  <li key={c.name} data-context={c.name}>
                    <strong>{c.name}</strong>
                    {c.role && <span className="hint"> · {c.role}</span>}
                  </li>
                ))}
              </ul>
            </>
          )}
          {summary.notes && (
            <>
              <h3>{t.run.arch.notes}</h3>
              <p>{summary.notes}</p>
            </>
          )}
        </>
      ) : (
        <div data-testid="arch-fallback">
          <p className="hint">{data.document ? t.run.arch.noSummary : t.run.arch.noDocument}</p>
          {doc.state === 'ready' && (
            <div className="doc-preview">
              <Markdown text={doc.text} />
            </div>
          )}
          {data.document && (
            <button type="button" className="btn small" onClick={() => onOpen(data.document!)}>
              {t.run.arch.openDocument}
            </button>
          )}
        </div>
      )}

      <h3>{t.run.arch.adrs}</h3>
      {data.adrs.length === 0 ? (
        <p className="hint">{t.run.arch.noAdrs}</p>
      ) : (
        <ul className="adrs">
          {data.adrs.map((a) => (
            <li key={a.id} data-adr={a.id}>
              <strong>{a.id}</strong> {a.title} <span className="chip small">{a.status}</span>
              {a.path && (
                <button type="button" className="link-btn" onClick={() => onOpen(a.path!)} aria-label={`${t.run.arch.openDocument}: ${a.path}`}>
                  {t.run.arch.openDocument}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {data.alignment.length > 0 && (
        <>
          <h3>{t.run.arch.alignment}</h3>
          <ul className="alignment">
            {data.alignment.map((a) => (
              <li key={a.adr} data-alignment={a.adr} data-aligned={a.aligned}>
                <strong>{a.adr}</strong>
                <span className={`chip small ${a.aligned ? 'done' : 'warn'}`}>{a.aligned ? t.run.arch.aligned : t.run.arch.misaligned}</span>
                {a.note && <span className="hint"> {a.note}</span>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>{t.run.arch.assumptions}</h3>
      {data.assumptions.length === 0 ? (
        <p className="hint">{t.run.arch.noAssumptions}</p>
      ) : (
        <>
          <p className="hint">{t.run.arch.assumptionsNote}</p>
          <ul className="assumptions">
            {data.assumptions.map((a, n) => (
              <li key={`${a.text}:${n}`} data-assumption>
                {a.text} <span className="hint">· {t.run.panel.ownerOf(a.owner)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
