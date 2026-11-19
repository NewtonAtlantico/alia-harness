import { useEffect, useReducer, useRef, useState } from 'react';
import type { ContextUsage } from '../../../shared/ipc';
import type { OpenConversation } from '../hooks/useWorkspace';
import { t } from '../i18n/pt-BR';
import { projectName } from '../lib/projectName';
import { stateOf, type SessionStates } from '../lib/sessionStates';
import { applyPush, rowsFromMessages } from '../lib/timeline';
import { ContextMeter, ModelChip } from './ConversationHeader';
import { Timeline } from './Timeline';

/**
 * The open conversation: its header (project, model, context meter) and the timeline. The timeline starts from what
 * is saved and then follows the engine's events live; give the pane a `key` of the conversation id so switching
 * conversations starts fresh.
 */
export function ConversationPane({ conversation, states, loading }: { conversation: OpenConversation; states: SessionStates; loading: boolean }) {
  const { info, opened } = conversation;
  const state = stateOf(states, info.id);
  const [timeline, dispatch] = useReducer(applyPush, conversation.messages, (messages) => rowsFromMessages(messages, { running: state.running }));
  const [usage, setUsage] = useState<ContextUsage>(opened.usage);
  const [model, setModel] = useState(opened.model);
  const root = useRef<HTMLElement>(null);
  const stick = useRef(true);

  // Follow the engine: events and the user's own message, for this conversation only.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.alia.onMessage((m) => {
      if ((m.kind === 'event' || m.kind === 'user_message') && m.sessionId === info.id) {
        dispatch(m);
        if (m.kind === 'event' && !m.event.subagentId && m.event.type === 'run_finished') {
          clearTimeout(timer);
          timer = setTimeout(() => void window.alia.request('session.usage', { sessionId: info.id }).then(setUsage, () => {}), 100);
        }
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [info.id]);

  // Stay at the bottom while the answer grows, unless the user has scrolled up to read.
  useEffect(() => {
    const scroller = root.current?.closest('.content') as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    };
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const scroller = root.current?.closest('.content') as HTMLElement | null;
    if (scroller && stick.current) scroller.scrollTop = scroller.scrollHeight;
  }, [timeline.rows, timeline.modelBusy]);

  const running = timeline.running || state.running;

  return (
    <article className="conversation" ref={root} aria-labelledby="conv-title" aria-busy={loading || running}>
      <header className="conv-header">
        <h1 id="conv-title" className="display">
          {info.title}
        </h1>
        <p className="hint">
          {t.conversation.project}: {projectName(info.workspace)}
        </p>
        <div className="conv-tools">
          <ModelChip sessionId={info.id} model={model} disabled={running} onSwitched={(id, u) => { setModel(id); if (u) setUsage(u); }} />
          <ContextMeter usage={usage} />
        </div>
        {state.waiting > 0 && (
          <p className="notice waiting" role="status">
            {t.conversation.waiting}
          </p>
        )}
      </header>
      {timeline.rows.length === 0 && !timeline.modelBusy ? <p className="hint">{t.conversation.empty}</p> : <Timeline state={timeline} />}
    </article>
  );
}
