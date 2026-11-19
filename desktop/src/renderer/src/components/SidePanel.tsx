import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { t } from '../i18n/pt-BR';
import type { Row } from '../lib/timeline';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { TerminalTab } from './TerminalTab';

type Tab = 'changes' | 'files' | 'terminal';
const TABS: Tab[] = ['changes', 'files', 'terminal'];
const KEY = 'alia.panelTab';

function savedTab(): Tab {
  try {
    const v = window.localStorage.getItem(KEY);
    return TABS.includes(v as Tab) ? (v as Tab) : 'changes';
  } catch {
    return 'changes';
  }
}

/**
 * The panel beside a conversation: what the agent changed (Alterações), the project's files (Arquivos) and a read-only
 * log of its commands (Terminal). Tabs follow the usual keyboard pattern: arrows move between them, Home and End jump.
 */
export function SidePanel({ sessionId, rows, refreshKey, onClose }: { sessionId: string; rows: Row[]; refreshKey: string; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(savedTab);
  const buttons = useRef<Record<Tab, HTMLButtonElement | null>>({ changes: null, files: null, terminal: null });

  useEffect(() => {
    try {
      window.localStorage.setItem(KEY, tab);
    } catch {
      /* ignore */
    }
  }, [tab]);

  const onKey = (e: KeyboardEvent) => {
    const at = TABS.indexOf(tab);
    const next = e.key === 'ArrowRight' ? TABS[(at + 1) % TABS.length] : e.key === 'ArrowLeft' ? TABS[(at - 1 + TABS.length) % TABS.length] : e.key === 'Home' ? TABS[0] : e.key === 'End' ? TABS[TABS.length - 1] : undefined;
    if (!next) return;
    e.preventDefault();
    setTab(next);
    buttons.current[next]?.focus();
  };

  return (
    <aside className="side-panel" aria-label={t.panel.label} data-testid="side-panel">
      <div className="panel-head">
        <div role="tablist" aria-label={t.panel.label} onKeyDown={onKey}>
          {TABS.map((id) => (
            <button key={id} ref={(el) => { buttons.current[id] = el; }} type="button" role="tab" id={`tab-${id}`} aria-selected={tab === id} aria-controls={`panel-${id}`} tabIndex={tab === id ? 0 : -1} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {t.panel.tabs[id]}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label={t.panel.close} title={t.panel.close} onClick={onClose}>
          ×
        </button>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="panel-body">
        {tab === 'changes' && <ChangesTab sessionId={sessionId} refreshKey={refreshKey} />}
        {tab === 'files' && <FilesTab sessionId={sessionId} refreshKey={refreshKey} />}
        {tab === 'terminal' && <TerminalTab rows={rows} />}
      </div>
    </aside>
  );
}
