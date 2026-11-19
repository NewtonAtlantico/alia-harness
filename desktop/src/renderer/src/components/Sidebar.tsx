import { useEffect, useRef, useState } from 'react';
import type { PipelineBrief, SearchHit, SessionInfo } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import { chipFor } from '../lib/pipelineChip';
import { projectName } from '../lib/projectName';
import { relativeTime } from '../lib/relativeTime';
import { stateOf, type SessionState, type SessionStates } from '../lib/sessionStates';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';

export interface SidebarProps {
  projects: string[];
  currentProject?: string;
  conversations: SessionInfo[];
  activeId?: string;
  pipelines: Record<string, PipelineBrief>;
  states: SessionStates;
  projectMarks: Record<string, SessionState>;
  query: string;
  results: SearchHit[] | null;
  searching: boolean;
  now: Date;
  onQuery: (text: string) => void;
  onNewConversation: () => void;
  onNewPipeline: () => void;
  /** A pipeline of the sidebar was clicked: show the conversation that runs it. */
  onOpenPipeline: (project: string) => void;
  /** The pipeline intake is the screen being shown. */
  pipelineActive?: boolean;
  onOpenFolder: () => void;
  onSelectProject: (projectPath: string) => void;
  onOpenConversation: (info: SessionInfo) => void;
  onRename: (info: SessionInfo, title: string) => void;
  onDelete: (info: SessionInfo) => void;
  onOpenSettings: () => void;
}

/** The mark beside a conversation or project: a spinner while it runs, an orange dot while it waits for the user. */
function Mark({ state }: { state: SessionState }) {
  if (state.waiting > 0) return <span className="mark waiting" role="img" aria-label={t.sidebar.waiting} title={t.sidebar.waiting} />;
  if (state.running) return <span className="mark spinner" role="img" aria-label={t.sidebar.running} title={t.sidebar.running} />;
  return null;
}

interface RowProps {
  info: SessionInfo;
  active: boolean;
  state: SessionState;
  now: Date;
  onOpen: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}

function ConversationRow({ info, active, state, now, onOpen, onRename, onDelete }: RowProps) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(info.title);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      input.current?.focus();
      input.current?.select();
    }
  }, [editing]);

  const finish = (save: boolean) => {
    if (!editing) return;
    setEditing(false);
    const next = title.trim();
    if (save && next && next !== info.title) onRename(next);
    else setTitle(info.title);
  };

  if (editing) {
    return (
      <li className="conv editing">
        <input
          ref={input}
          aria-label={t.sidebar.renameInput}
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') finish(true);
            else if (e.key === 'Escape') finish(false);
          }}
          onBlur={() => finish(true)}
        />
      </li>
    );
  }

  return (
    <li className={`conv ${active ? 'active' : ''}`}>
      <button type="button" className="conv-main" aria-current={active ? 'true' : undefined} onClick={onOpen}>
        <span className="conv-title">{info.title}</span>
        <span className="conv-meta">
          <Mark state={state} />
          <span className="hint">{relativeTime(info.updatedAt, now)}</span>
        </span>
      </button>
      <span className="conv-actions">
        <button
          type="button"
          className="icon-btn"
          aria-label={t.sidebar.rename(info.title)}
          title={t.sidebar.rename(info.title)}
          onClick={() => {
            setTitle(info.title);
            setEditing(true);
          }}
        >
          ✎
        </button>
        <button type="button" className="icon-btn" aria-label={t.sidebar.delete(info.title)} title={t.sidebar.delete(info.title)} onClick={onDelete}>
          ×
        </button>
      </span>
    </li>
  );
}

export function Sidebar(p: SidebarProps) {
  const [deleting, setDeleting] = useState<SessionInfo>();
  const searching = p.query.trim() !== '';
  const pipelineRows = p.projects.filter((project) => p.pipelines[project] && chipFor(p.pipelines[project]));

  return (
    <nav className="sidebar" aria-label={t.sidebar.label}>
      <button type="button" className="btn primary new-conversation" onClick={p.onNewConversation}>
        {t.sidebar.newConversation} <kbd>Ctrl N</kbd>
      </button>
      <button type="button" className="btn new-pipeline" data-testid="new-pipeline" aria-current={p.pipelineActive ? 'page' : undefined} title={t.pipeline.openTitle} onClick={p.onNewPipeline}>
        {t.sidebar.newPipeline}
      </button>

      <div role="search" className="search">
        <input type="search" aria-label={t.sidebar.search} placeholder={t.sidebar.searchPlaceholder} value={p.query} onChange={(e) => p.onQuery(e.target.value)} />
      </div>

      {searching ? (
        <section aria-label={t.sidebar.search} className="results">
          {p.searching && !p.results && <p className="hint">{t.sidebar.searching}</p>}
          {p.results && p.results.length === 0 && <p className="hint">{t.sidebar.noResults}</p>}
          <ul>
            {(p.results ?? []).map((hit) => (
              <li key={hit.info.id} className="conv">
                <button type="button" className="conv-main" onClick={() => p.onOpenConversation(hit.info)}>
                  <span className="conv-title">{hit.info.title}</span>
                  <span className="hint">{t.sidebar.resultsIn(projectName(hit.info.workspace))}</span>
                  {hit.matches[0] && hit.matches[0].where !== 'title' && <span className="snippet">{hit.matches[0].snippet}</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <>
          {pipelineRows.length > 0 && (
            <section aria-labelledby="sb-pipelines">
              <h2 id="sb-pipelines">{t.sidebar.pipelines}</h2>
              <ul>
                {pipelineRows.map((project) => {
                  const brief = p.pipelines[project];
                  const chip = chipFor(brief)!;
                  return (
                    <li key={project} className="conv">
                      <button type="button" className="conv-main" aria-label={`${t.sidebar.pipelineOf(projectName(project))}: ${brief.project ?? projectName(project)} ${chip.label}`} title={brief.summary} onClick={() => p.onOpenPipeline(project)}>
                        <span className="conv-title">{brief.project ?? projectName(project)}</span>{' '}
                        <span className={`chip ${chip.tone}`} data-testid="pipeline-chip">
                          {chip.label}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          <section aria-labelledby="sb-projects">
            <div className="section-head">
              <h2 id="sb-projects">{t.sidebar.projects}</h2>
              <button type="button" className="btn small" title={t.sidebar.openFolderTitle} onClick={p.onOpenFolder}>
                {t.sidebar.openFolder}
              </button>
            </div>
            {p.projects.length === 0 ? (
              <p className="hint">{t.sidebar.noProject}</p>
            ) : (
              <ul aria-label={t.sidebar.projects}>
                {p.projects.map((project) => (
                  <li key={project} className={`conv ${project === p.currentProject ? 'active' : ''}`}>
                    <button type="button" className="conv-main" aria-current={project === p.currentProject ? 'true' : undefined} title={project} onClick={() => p.onSelectProject(project)}>
                      <span className="conv-title">{projectName(project)}</span>
                      <Mark state={p.projectMarks[project] ?? { running: false, waiting: 0 }} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {p.currentProject && (
            <section aria-labelledby="sb-recents">
              <h2 id="sb-recents">{t.sidebar.recents}</h2>
              {p.conversations.length === 0 ? (
                <p className="hint">{t.sidebar.noConversations}</p>
              ) : (
                <ul aria-label={t.sidebar.conversationsOf(projectName(p.currentProject))}>
                  {p.conversations.map((info) => (
                    <ConversationRow
                      key={info.id}
                      info={info}
                      active={info.id === p.activeId}
                      state={stateOf(p.states, info.id)}
                      now={p.now}
                      onOpen={() => p.onOpenConversation(info)}
                      onRename={(title) => p.onRename(info, title)}
                      onDelete={() => setDeleting(info)}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
        </>
      )}

      <div className="grow" />
      <button type="button" className="btn" onClick={p.onOpenSettings}>
        {t.sidebar.settings}
      </button>

      {deleting && (
        <ConfirmDeleteDialog
          title={deleting.title}
          onCancel={() => setDeleting(undefined)}
          onConfirm={() => {
            const info = deleting;
            setDeleting(undefined);
            p.onDelete(info);
          }}
        />
      )}
    </nav>
  );
}
