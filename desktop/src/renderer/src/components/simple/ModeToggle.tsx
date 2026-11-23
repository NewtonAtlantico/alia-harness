import { t } from '../../i18n/pt-BR';
import type { Mode } from '../../lib/simple';

/** "Simples | Técnico": the two ways to use the app. The same projects show in both. */
export function ModeToggle({ mode, onChange }: { mode: Mode; onChange: (mode: Mode) => void }) {
  return (
    <div className="mode-toggle" role="group" aria-label={t.mode.label} data-testid="mode-toggle">
      {(['simple', 'technical'] as const).map((m) => (
        <button key={m} type="button" aria-pressed={mode === m} title={m === 'simple' ? t.mode.simpleHint : t.mode.technicalHint} data-mode={m} onClick={() => mode !== m && onChange(m)}>
          {t.mode[m]}
        </button>
      ))}
    </div>
  );
}
