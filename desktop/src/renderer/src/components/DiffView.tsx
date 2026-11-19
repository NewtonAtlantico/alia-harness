import { useMemo, useState } from 'react';
import { t } from '../i18n/pt-BR';
import { parseDiff } from '../lib/diff';

const FIRST_LINES = 1500;

/**
 * A unified diff, drawn inline: old and new line numbers, a +/- column, added lines green and removed ones red. Long lines
 * scroll sideways (nothing is wrapped, so columns stay aligned); a very large diff shows its first lines and offers the rest.
 */
export function DiffView({ diff, truncated, label }: { diff: string; truncated?: boolean; label: string }) {
  const lines = useMemo(() => parseDiff(diff).lines.filter((l) => l.kind !== 'meta'), [diff]);
  const [all, setAll] = useState(false);
  const shown = all ? lines : lines.slice(0, FIRST_LINES);

  if (lines.length === 0) return <p className="hint">{t.panel.changes.noDiff}</p>;
  return (
    <div className="diff-wrap">
      <div className="diff" role="region" aria-label={label} tabIndex={0} data-testid="diff">
        {shown.map((l, i) => (
          <div key={i} className={`dl ${l.kind}`}>
            <span className="no" aria-hidden="true">{l.oldNo ?? ''}</span>
            <span className="no" aria-hidden="true">{l.newNo ?? ''}</span>
            <span className="sign" aria-hidden="true">{l.kind === 'add' ? '+' : l.kind === 'remove' ? '−' : ''}</span>
            <span className="code">{l.text || ' '}</span>
          </div>
        ))}
      </div>
      {!all && lines.length > FIRST_LINES && (
        <button type="button" className="btn small" onClick={() => setAll(true)}>
          {t.panel.changes.showAll(lines.length)}
        </button>
      )}
      {truncated && <p className="hint">{t.panel.changes.truncated}</p>}
    </div>
  );
}
