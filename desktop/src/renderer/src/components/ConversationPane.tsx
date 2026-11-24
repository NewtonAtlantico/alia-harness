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
import { usePipelineView } from '../hooks/usePipelineView';
import { gateCardFor } from '../lib/pipelineRun';
import { GateCard } from './GateCard';
import { InteractionCards } from './InteractionCards';
import { ArchitecturePanel } from './ArchitecturePanel';
import { FinalReport } from './FinalReport';
import { PipelineHeader } from './PipelineHeader';
import { SpecsPanel } from './SpecsPanel';
import { architectureFor, specsFor, stagePanelFor } from '../lib/stagePanels';
import { QuestionCard } from './QuestionCard';
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
  /** This conversation runs a pipeline: it shows the stepper, the gate card and the pipeline tab. */
  pipeline?: boolean;
}

/**
 * The open conversation: its header (project, model, context meter), the timeline, and the composer. The timeline starts
 * from what is saved and then follows the engine's events live; give the pane a `key` of the conversation id so
 * switching conversations starts fresh.
 */
export function ConversationPane({ conversation, states, loading, intro, configured, onOpenSettings, onStarted, interactions, onRespond, defaultOwner, panelOpen, onTogglePanel, pipeline = false }: PaneProps) {
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

  // A pipeline conversation: its state, read again as the run goes on.
  const { view, reload } = usePipelineView(info.workspace, pipeline, panelKey);
  const [pipelineError, setPipelineError] = useState<string>();
  const [resuming, setResuming] = useState(false);
  const mine = forSession(interactions, info.id);
  const idle = pipeline && !!view && !running && mine.length === 0;
  const card = idle && view ? gateCardFor(view) : null;
  const stage = idle && view ? stagePanelFor(view) : null;
  const arch = stage === 'architecture' && view ? architectureFor(view) : null;
  const specs = stage === 'specs' && view ? specsFor(view) : null;
  const done = idle && !!view && view.status.next.kind === 'complete';
  const resume = useCallback(async () => {
    setResuming(true);
    setPipelineError(undefined);
    try {
      await api('pipeline.resume', { sessionId: info.id });
      onStarted();
    } catch (err) {
      setPipelineError(String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, ''));
    } finally {
      setResuming(false);
    }
  }, [api, info.id, onStarted]);
  const openFile = useCallback(
    async (file: string) => {
      setPipelineError(undefined);
      try {
        await api('projects.openFile', { projectPath: info.workspace, path: file });
      } catch (err) {
        setPipelineError(t.run.openFailed(String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '')));
      }
    },
    [api, info.workspace]
  );

  return (
    <div className="pane">
    <div className="pane-main">
    <article className="conversation" ref={root} aria-labelledby={starting ? undefined : 'conv-title'} aria-busy={loading || running}>
      {starting && intro}
      {pipeline && view?.status.exists && <PipelineHeader view={view} running={running} busy={resuming} error={pipelineError} onPause={stop} onResume={() => void resume()} onOpenState={() => void openFile('docs/pipeline/STATE.md')} />}
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
      <InteractionCards
        interactions={mine}
        defaultOwner={defaultOwner}
        onRespond={onRespond}
        renderQuestions={
          pipeline
            ? (interaction, answer, queued) => (
                <>
                  <p className="hint">{t.run.gate.model}</p>
                  <QuestionCard key={interaction.id} interaction={interaction} queued={queued} defaultOwner={defaultOwner} onAnswer={answer} />
                </>
              )
            : undefined
        }
      />
      {done && view && <FinalReport view={view} sessionId={info.id} project={info.workspace} onOpen={(file) => void openFile(file)} onStarted={onStarted} />}
      {arch && <ArchitecturePanel data={arch} sessionId={info.id} onOpen={(file) => void openFile(file)} />}
      {specs && <SpecsPanel key={info.id} data={specs} sessionId={info.id} by={defaultOwner.trim() || 'Usuário'} onChanged={reload} onResume={resume} onStarted={onStarted} />}
      {card && !(stage === 'specs' && card.ready) && <GateCard key={card.gate} card={card} sessionId={info.id} defaultOwner={defaultOwner} onChanged={reload} onResume={resume} title={stage === 'architecture' ? t.run.arch.reviewTitle : undefined} chip={stage === 'architecture' ? arch?.recommendation : undefined} follows={stage !== 'specs'} />}
      <div className="composer-dock">
        <Composer sessionId={info.id} running={running} blockedReason={configured ? undefined : t.composer.notConfigured} onOpenSettings={onOpenSettings} onSubmit={submit} onStop={stop} />
      </div>
    </article>
    </div>
    {panelOpen && <SidePanel sessionId={info.id} rows={timeline.rows} refreshKey={panelKey} onClose={onTogglePanel} pipeline={pipeline ? { view, onOpen: (file) => void openFile(file), error: pipelineError } : undefined} />}
    </div>
  );
}
