import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { PipelineView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import type { Row } from '../lib/timeline';
import { ChangesTab } from './ChangesTab';
import { FilesTab } from './FilesTab';
import { PipelineTab } from './PipelineTab';
import { TerminalTab } from './TerminalTab';

type Tab = 'pipeline' | 'changes' | 'files' | 'terminal';
const BASE_TABS: Tab[] = ['changes', 'files', 'terminal'];
const KEY = 'alia.panelTab';

function savedTab(tabs: Tab[]): Tab {
  try {
    const v = window.localStorage.getItem(KEY);
    return tabs.includes(v as Tab) ? (v as Tab) : tabs[0];
  } catch {
    return tabs[0];
  }
}

const tabLabel = (id: Tab): string => (id === 'pipeline' ? t.run.panel.tab : t.panel.tabs[id]);

/**
 * The panel beside a conversation: what the agent changed (Alterações), the project's files (Arquivos) and a read-only
 * log of its commands (Terminal). Tabs follow the usual keyboard pattern: arrows move between them, Home and End jump.
 */
export function SidePanel({ sessionId, rows, refreshKey, onClose, pipeline }: { sessionId: string; rows: Row[]; refreshKey: string; onClose: () => void; pipeline?: { view?: PipelineView; onOpen: (path: string) => void; error?: string } }) {
  const TABS: Tab[] = pipeline ? ['pipeline', ...BASE_TABS] : BASE_TABS;
  const [tab, setTab] = useState<Tab>(() => savedTab(TABS));
  const buttons = useRef<Record<Tab, HTMLButtonElement | null>>({ pipeline: null, changes: null, files: null, terminal: null });

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
              {tabLabel(id)}
            </button>
          ))}
        </div>
        <button type="button" className="icon-btn" aria-label={t.panel.close} title={t.panel.close} onClick={onClose}>
          ×
        </button>
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="panel-body">
        {tab === 'pipeline' && pipeline && <PipelineTab view={pipeline.view} onOpen={pipeline.onOpen} error={pipeline.error} />}
        {tab === 'changes' && <ChangesTab sessionId={sessionId} refreshKey={refreshKey} />}
        {tab === 'files' && <FilesTab sessionId={sessionId} refreshKey={refreshKey} />}
        {tab === 'terminal' && <TerminalTab rows={rows} />}
      </div>
    </aside>
  );
}
