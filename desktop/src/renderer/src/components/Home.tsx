import { t } from '../i18n/pt-BR';
import { greetingFor } from '../lib/greeting';
import { projectName } from '../lib/projectName';

/** The start screen: a greeting by the time of day, the current project, and what is missing to begin. */
export function Home({ name, project, now, configured, onSetup }: { name: string; project?: string; now: Date; configured: boolean; onSetup: () => void }) {
  return (
    <section className="home" aria-labelledby="home-greeting">
      <h1 id="home-greeting" className="display">
        {greetingFor(now, name)}
      </h1>
      <p className="chip-line">
        <span className="chip project" data-testid="project-chip" title={project}>
          {project ? t.home.project(projectName(project)) : t.home.noProject}
        </span>
      </p>
      {!configured && (
        <p className="banner info">
          {t.home.needsSetup}{' '}
          <button type="button" className="btn primary" onClick={onSetup}>
            {t.home.configure}
          </button>
        </p>
      )}
      <p className="hint">{t.home.hint}</p>
    </section>
  );
}
