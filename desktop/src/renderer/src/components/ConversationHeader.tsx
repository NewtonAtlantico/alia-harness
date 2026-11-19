import { useEffect, useRef, useState } from 'react';
import type { ContextUsage, ModelList } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

/** The model in use. Click to list the configured models and switch (not while a run is going). */
export function ModelChip({ sessionId, model, disabled, onSwitched }: { sessionId: string; model: string; disabled: boolean; onSwitched: (model: string, usage?: ContextUsage) => void }) {
  const [list, setList] = useState<ModelList>();
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!list) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setList(undefined);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setList(undefined);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', key);
    };
  }, [list]);

  const toggle = async () => {
    if (list) return setList(undefined);
    setError(undefined);
    try {
      setList(await window.alia.request('model.list', { sessionId }));
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  const choose = async (id: string) => {
    setList(undefined);
    if (id === model) return;
    try {
      const r = await window.alia.request('model.switch', { sessionId, model: id });
      if (r.ok) onSwitched(r.id, await window.alia.request('session.usage', { sessionId }));
    } catch (e) {
      setError(String((e as Error).message));
    }
  };

  return (
    <div className="model-chip" ref={root}>
      <button type="button" className="chip project" aria-haspopup="menu" aria-expanded={!!list} disabled={disabled} title={disabled ? t.timeline.header.modelBusy : t.timeline.header.switchModel} onClick={toggle} data-testid="model-chip">
        {t.timeline.header.model}: {model} <span aria-hidden="true">▾</span>
      </button>
      {list && (
        <ul className="menu" role="menu" aria-label={t.timeline.header.models}>
          {list.configured.map((m) => (
            <li key={m.id} role="none">
              <button type="button" role="menuitemradio" aria-checked={m.id === model} className={m.id === model ? 'selected' : ''} onClick={() => choose(m.id)}>
                {m.name}
                {m.name !== m.id && <span className="hint"> {m.id}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && <span className="error">{error}</span>}
    </div>
  );
}

/** How much of the model's context window the conversation uses. */
export function ContextMeter({ usage }: { usage: ContextUsage }) {
  const percent = Math.min(100, Math.max(0, usage.percent));
  const tone = percent >= 90 ? 'bad' : percent >= 70 ? 'warn' : 'ok';
  return (
    <div className={`context-meter ${tone}`} role="meter" aria-label={t.timeline.header.context} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={t.timeline.header.contextValue(percent)} title={t.timeline.header.contextTitle(usage.tokens, usage.limit)} data-testid="context-meter">
      <span className="bar" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </span>
      <span className="hint">{t.timeline.header.contextValue(percent)}</span>
    </div>
  );
}
