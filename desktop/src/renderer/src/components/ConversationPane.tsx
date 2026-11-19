import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { CommandInfo, ContextUsage, InteractionResponse } from '../../../shared/ipc';
import type { OpenConversation } from '../hooks/useWorkspace';
import { t } from '../i18n/pt-BR';
import { parseSlash, withAttachments } from '../lib/composer';
import { forSession, type Pending } from '../lib/interactions';
import { compactMessage, helpText, isLocalCommand, modelsText, skillsText, tokensText } from '../lib/localCommands';
import { projectName } from '../lib/projectName';
import { stateOf, type SessionStates } from '../lib/sessionStates';
import { applyPush, rowsFromMessages } from '../lib/timeline';
import { Composer, type ComposerSubmit } from './Composer';
import { ContextMeter, ModelChip } from './ConversationHeader';
import { InteractionCards } from './InteractionCards';
import { SidePanel } from './SidePanel';
import { Timeline } from './Timeline';

interface PaneProps {
  conversation: OpenConversation;
  states: SessionStates;
  loading: boolean;
  /** Shown instead of the header while the conversation has not started (the greeting). */
  intro?: ReactNode;
  /** False until an endpoint, a model and a key are set: nothing can be sent. */
  configured: boolean;
  onOpenSettings: () => void;
  /** The first message of a new conversation was sent. */
  onStarted: () => void;
  /** Everything waiting for an answer, in every conversation; this pane shows its own. */
  interactions: Pending;
  onRespond: (id: string, response: InteractionResponse) => void;
  /** Who owns an assumption by default (the user's name). */
  defaultOwner: string;
  /** The panel beside the conversation (changes, files, terminal). */
  panelOpen: boolean;
  onTogglePanel: () => void;
}

/**
 * The open conversation: its header (project, model, context meter), the timeline, and the composer. The timeline starts
 * from what is saved and then follows the engine's events live; give the pane a `key` of the conversation id so
 * switching conversations starts fresh.
 */
export function ConversationPane({ conversation, states, loading, intro, configured, onOpenSettings, onStarted, interactions, onRespond, defaultOwner, panelOpen, onTogglePanel }: PaneProps) {
  const { info, opened } = conversation;
  const state = stateOf(states, info.id);
  const [timeline, dispatch] = useReducer(applyPush, conversation.messages, (messages) => rowsFromMessages(messages, { running: state.running, annotations: conversation.annotations, interrupted: opened.interrupted }));
  const [usage, setUsage] = useState<ContextUsage>(opened.usage);
  const [model, setModel] = useState(opened.model);
  const root = useRef<HTMLElement>(null);
  const stick = useRef(true);
  const running = timeline.running || state.running;
  const api = window.alia.request;

  // Follow the engine: events and the user's own message, for this conversation only.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = window.alia.onMessage((m) => {
      if ((m.kind === 'event' || m.kind === 'user_message') && m.sessionId === info.id) {
        dispatch(m);
        if (m.kind === 'event' && !m.event.subagentId && (m.event.type === 'run_finished' || m.event.type === 'context_compacted')) {
          clearTimeout(timer);
          timer = setTimeout(() => void api('session.usage', { sessionId: info.id }).then(setUsage, () => {}), 100);
        }
      }
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [info.id, api]);

  // Stay at the bottom while the answer grows, unless the user has scrolled up to read.
  useEffect(() => {
    const scroller = root.current?.closest('.pane-main') as HTMLElement | null;
    if (!scroller) return;
    const onScroll = () => {
      stick.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 140;
    };
    scroller.addEventListener('scroll', onScroll);
    return () => scroller.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    const scroller = root.current?.closest('.pane-main') as HTMLElement | null;
    if (scroller && stick.current) scroller.scrollTop = scroller.scrollHeight;
  }, [timeline.rows, timeline.modelBusy]);

  const local = useCallback((command: string, text: string) => dispatch({ kind: 'local', command, text }), []);
  const refreshUsage = useCallback(() => api('session.usage', { sessionId: info.id }).then(setUsage, () => {}), [api, info.id]);

  /** The commands only the app can carry out (the same ones the CLI offers, and /config). */
  const runLocal = useCallback(
    async (name: string, arg: string) => {
      const sessionId = info.id;
      switch (name) {
        case 'help':
          return local(name, helpText(await api('commands.list', { sessionId })));
        case 'skills':
          return local(name, skillsText(await api('commands.list', { sessionId })));
        case 'models':
          return local(name, modelsText(await api('model.list', { sessionId })));
        case 'model': {
          if (!arg) {
            const list = await api('model.list', { sessionId });
            return local(name, `${t.composer.local.modelCurrent(list.current)}\n${modelsText(list)}`);
          }
          if (running) return local(name, t.composer.local.busy);
          const r = await api('model.switch', { sessionId, model: arg });
          if (!r.ok) return local(name, t.composer.local.modelUnknown(arg, r.available));
          setModel(r.id);
          void refreshUsage();
          return local(name, t.composer.local.modelSwitched(r.id));
        }
        case 'tokens': {
          const u = await api('session.usage', { sessionId });
          setUsage(u);
          return local(name, tokensText(u));
        }
        case 'clear':
          if (running) return local(name, t.composer.local.busy);
          await api('session.reset', { sessionId });
          dispatch({ kind: 'cleared' });
          void refreshUsage();
          return local(name, t.composer.local.cleared);
        case 'compact': {
          if (running) return local(name, t.composer.local.busy);
          const r = await api('session.compact', { sessionId });
          const message = compactMessage(r);
          if (message) local(name, message);
          void refreshUsage();
          return;
        }
        case 'config':
          return onOpenSettings();
      }
    },
    [api, info.id, local, onOpenSettings, refreshUsage, running]
  );

  const submit = useCallback(
    async ({ text, attachments }: ComposerSubmit) => {
      const slash = parseSlash(text);
      if (slash && isLocalCommand(slash.name)) return runLocal(slash.name, slash.arg);
      if (slash) {
        // A name the app does not carry out itself: a skill goes to the engine; another command the CLI has does not exist here.
        const known: CommandInfo[] = await api('commands.list', { sessionId: info.id }).catch(() => []);
        const hit = known.find((c) => c.name.toLowerCase() === slash.name);
        if (hit && hit.kind !== 'skill') return local(slash.name, t.composer.local.unknown(slash.name));
      }
      onStarted();
      await api('session.run', { sessionId: info.id, text: withAttachments(text, attachments) });
    },
    [api, info.id, local, onStarted, runLocal]
  );

  const stop = useCallback(() => void api('session.cancel', { sessionId: info.id }), [api, info.id]);
  const starting = conversation.draft && timeline.rows.length === 0 && !timeline.modelBusy;
  // The panel reloads when a tool call finishes (it may have written something) and when the run starts or ends.
  const finishedCalls = timeline.rows.filter((r) => r.kind === 'tool' && r.status !== 'running').length;
  const panelKey = `${finishedCalls}:${timeline.running ? 'run' : 'idle'}`;

  return (
    <div className="pane">
    <div className="pane-main">
    <article className="conversation" ref={root} aria-labelledby={starting ? undefined : 'conv-title'} aria-busy={loading || running}>
      {starting && intro}
      <header className="conv-header">
        {!starting && (
          <>
            <h1 id="conv-title" className="display">
              {info.title}
            </h1>
            <p className="hint">
              {t.conversation.project}: {projectName(info.workspace)}
            </p>
          </>
        )}
        <div className="conv-tools">
          <ModelChip sessionId={info.id} model={model} disabled={running} onSwitched={(id, u) => { setModel(id); if (u) setUsage(u); }} />
          <ContextMeter usage={usage} />
          <button type="button" className="btn small" aria-pressed={panelOpen} title={t.panel.toggleTitle} onClick={onTogglePanel} data-testid="panel-toggle">
            {t.panel.toggle}
          </button>
        </div>
        {state.waiting > 0 && (
          <p className="notice waiting" role="status">
            {t.conversation.waiting}{' '}
            <button type="button" className="link-btn" onClick={() => root.current?.querySelector('[data-testid=interaction-card]')?.scrollIntoView({ block: 'center' })}>
              {t.approval.goTo}
            </button>
          </p>
        )}
      </header>
      {timeline.rows.length === 0 && !timeline.modelBusy ? (starting ? null : <p className="hint">{t.conversation.empty}</p>) : <Timeline state={timeline} />}
      <InteractionCards interactions={forSession(interactions, info.id)} defaultOwner={defaultOwner} onRespond={onRespond} />
      <div className="composer-dock">
        <Composer sessionId={info.id} running={running} blockedReason={configured ? undefined : t.composer.notConfigured} onOpenSettings={onOpenSettings} onSubmit={submit} onStop={stop} />
      </div>
    </article>
    </div>
    {panelOpen && <SidePanel sessionId={info.id} rows={timeline.rows} refreshKey={panelKey} onClose={onTogglePanel} />}
    </div>
  );
}
