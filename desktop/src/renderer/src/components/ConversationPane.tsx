import type { OpenConversation } from '../hooks/useWorkspace';
import { t } from '../i18n/pt-BR';
import { textRows } from '../lib/messageText';
import { projectName } from '../lib/projectName';
import { stateOf, type SessionStates } from '../lib/sessionStates';

/**
 * The open conversation. Until the timeline exists (A6) this is a plain reading view: what was said and answered,
 * with the marks that show it is running or waiting.
 */
export function ConversationPane({ conversation, states, loading }: { conversation: OpenConversation; states: SessionStates; loading: boolean }) {
  const { info, opened, messages } = conversation;
  const state = stateOf(states, info.id);
  const rows = textRows(messages);
  return (
    <article className="conversation" aria-labelledby="conv-title" aria-busy={loading}>
      <header>
        <h1 id="conv-title" className="display">
          {info.title}
        </h1>
        <p className="hint">
          {t.conversation.project}: {projectName(info.workspace)} · {t.conversation.model}: {opened.model} · {t.conversation.context(opened.usage.percent)} · {t.conversation.messages(messages.length)}
        </p>
        {state.waiting > 0 ? (
          <p className="notice waiting" role="status">
            {t.conversation.waiting}
          </p>
        ) : state.running ? (
          <p className="notice" role="status">
            {t.conversation.running}
          </p>
        ) : null}
      </header>
      {rows.length === 0 ? (
        <p className="hint">{t.conversation.empty}</p>
      ) : (
        <ol className="rows" aria-label={info.title}>
          {rows.map((row, i) => (
            <li key={i} className={`row-${row.role}`}>
              <strong>{row.role === 'user' ? t.conversation.you : t.conversation.assistant}</strong>
              <div className="bubble">{row.text}</div>
            </li>
          ))}
        </ol>
      )}
    </article>
  );
}
