import type { PipelineBrief } from '../../../../shared/ipc';
import { t } from '../../i18n/pt-BR';
import { isSimpleProject, simpleChip, simpleTitle } from '../../lib/simple';

/**
 * The sidebar of the simple view: a way to begin a project, the person's projects with whose turn it is on each, how it works, and
 * who they are. No conversations, folders or pipelines: those are the technical view's.
 */
export function SimpleSidebar({
  projects,
  pipelines,
  currentProject,
  creating,
  name,
  organization,
  onNew,
  onOpen,
  onHow,
  onSettings,
}: {
  projects: string[];
  pipelines: Record<string, PipelineBrief>;
  currentProject?: string;
  /** The "Novo projeto" form is the screen being shown. */
  creating: boolean;
  name: string;
  organization: string;
  onNew: () => void;
  onOpen: (project: string) => void;
  onHow: () => void;
  onSettings: () => void;
}) {
  const mine = projects.filter((p) => isSimpleProject(pipelines[p]));
  const initial = (name.trim()[0] ?? '?').toUpperCase();
  return (
    <nav className="sidebar simple-sidebar" aria-label={t.simple.navLabel}>
      <button type="button" className="btn primary new-project" data-testid="simple-new" aria-current={creating ? 'page' : undefined} onClick={onNew}>
        <span aria-hidden="true">＋</span> {t.simple.newProject}
      </button>
      <section aria-labelledby="sb-mine">
        <h2 id="sb-mine">{t.simple.myProjects}</h2>
        {mine.length === 0 ? (
          <p className="hint">{t.simple.noProjects}</p>
        ) : (
          <ul>
            {mine.map((project) => {
              const brief = pipelines[project];
              const chip = simpleChip(brief);
              const title = simpleTitle(project, brief);
              const active = !creating && project === currentProject;
              return (
                <li key={project} className={`conv ${active ? 'active' : ''}`}>
                  <button type="button" className="conv-main" title={title} aria-current={active ? 'true' : undefined} data-testid="simple-project" data-project={title} onClick={() => onOpen(project)}>
                    <span className="conv-title">{title}</span>
                    {chip && (
                      <span className={`chip ${chip.tone}`} data-testid="simple-chip">
                        {chip.label}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="grow" />
      <button type="button" className="link-btn how-link" onClick={onHow}>
        <span aria-hidden="true">?</span> {t.simple.howItWorks}
      </button>
      <button type="button" className="account" title={t.simple.account} aria-label={`${t.simple.account}: ${name}`} onClick={onSettings}>
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="who">
          <strong>{name}</strong>
          <span className="hint">{organization}</span>
        </span>
      </button>
    </nav>
  );
}
