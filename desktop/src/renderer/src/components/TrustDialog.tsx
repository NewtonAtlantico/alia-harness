import type { TrustPrompt } from '../hooks/useWorkspace';
import { t } from '../i18n/pt-BR';
import { projectName } from '../lib/projectName';
import { Dialog } from './Dialog';

/** Asked once per folder, before a project's own skills are loaded. Closing it with Esc is "Agora não". */
export function TrustDialog({ prompt, onAnswer }: { prompt: TrustPrompt; onAnswer: (trusted: boolean) => void }) {
  return (
    <Dialog labelledBy="trust-title" onCancel={() => onAnswer(false)}>
      <h2 id="trust-title">{t.trust.title}</h2>
      <p className="path" title={prompt.projectPath}>
        <strong>{projectName(prompt.projectPath)}</strong> <span className="hint">{prompt.projectPath}</span>
      </p>
      <p>{t.trust.body}</p>
      <p className="hint">{t.trust.skills(prompt.skills.length)}</p>
      <ul className="skill-list">
        {prompt.skills.map((s) => (
          <li key={s}>
            <code>{s}</code>
          </li>
        ))}
      </ul>
      <p className="hint">{t.trust.notNowHint}</p>
      <div className="dialog-actions">
        <button type="button" className="btn" data-autofocus onClick={() => onAnswer(false)}>
          {t.trust.notNow}
        </button>
        <button type="button" className="btn primary" onClick={() => onAnswer(true)}>
          {t.trust.trust}
        </button>
      </div>
    </Dialog>
  );
}
