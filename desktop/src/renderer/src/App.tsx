import { useEffect, useState } from 'react';
import type { IntakeProblem, PipelineInputRef, SettingsView } from '../../shared/ipc';
import { ConversationPane } from './components/ConversationPane';
import { Home } from './components/Home';
import { PipelineIntake, type IntakeNotice } from './components/PipelineIntake';
import { SettingsScreen } from './components/SettingsScreen';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { TrustDialog } from './components/TrustDialog';
import { useInteractions } from './hooks/useInteractions';
import { useWorkspace } from './hooks/useWorkspace';
import { t } from './i18n/pt-BR';
import type { IntakeRow } from './lib/intake';
import { isPipelineSession, markPipelineSession, pipelineSessions } from './lib/pipelineSessions';

type Screen = 'chat' | 'settings' | 'pipeline';

/** Two frames: long enough for a screen that was just switched to to be on the page and listening. */
const nextFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/** The app: title bar, the sidebar (projects, conversations, search, pipelines) and the screen beside it. */
export function App() {
  const [screen, setScreen] = useState<Screen>('chat');
  const [settings, setSettings] = useState<SettingsView>();
  const [now, setNow] = useState(() => new Date());
  const [panelOpen, setPanelOpen] = useState(() => {
    try {
      return window.localStorage.getItem('alia.panelOpen') === '1';
    } catch {
      return false;
    }
  });
  const [intakeRows, setIntakeRows] = useState<IntakeRow[]>([]);
  const [pipelineEpoch, setPipelineEpoch] = useState(0);
  const [intakeNotice, setIntakeNotice] = useState<IntakeNotice>({ problems: [] });
  const inter = useInteractions();
  const ws = useWorkspace(() => setScreen('chat'), inter.pending);

  useEffect(() => {
    window.alia.request('settings.get', {}).then((s) => {
      setSettings(s);
      if (!s.configured) setScreen('settings'); // first run: nothing works until the endpoint and key are set
    });
    const off = window.alia.onMessage((m) => {
      if (m.kind === 'command' && m.command === 'open_settings') setScreen('settings');
      if (m.kind === 'command' && m.command === 'toggle_panel') setPanelOpen((open) => !open);
    });
    const tick = setInterval(() => setNow(new Date()), 60_000); // the greeting and "há 5 min" follow the clock
    return () => {
      off();
      clearInterval(tick);
    };
  }, []);

  /**
   * Starts the pipeline in a conversation of its own. The conversation is on screen before the engine is asked, so the run is
   * seen from its first line; if the engine refuses (a file cannot be used) the intake comes back, with its files, and says why.
   */
  const runInNewConversation = async (project: string, call: (sessionId: string) => Promise<IntakeProblem[] | string | undefined>): Promise<IntakeProblem[] | string | undefined> => {
    const sessionId = await ws.actions.freshDraft(project);
    if (!sessionId) throw new Error(t.pipeline.startFailed('a conversa não pôde ser aberta'));
    markPipelineSession(sessionId); // this conversation shows the stepper and the gate card
    setScreen('chat');
    await nextFrames();
    try {
      const refused = await call(sessionId);
      if (refused) {
        setScreen('pipeline');
        // The intake was left to show the conversation, so it is a new instance now: the reason is kept here for it.
        if (typeof refused === 'string') setIntakeNotice({ problems: [], error: refused });
        else setIntakeNotice({ problems: refused });
        return refused;
      }
      ws.actions.markStarted();
      setIntakeRows([]);
      setPipelineEpoch((n) => n + 1);
      return undefined;
    } catch (err) {
      setScreen('pipeline');
      setIntakeNotice({ problems: [], error: String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '') });
      throw err;
    }
  };
  /** A pipeline in the sidebar opens the conversation that runs it (the newest one of that project), or just the project. */
  const openPipeline = async (project: string) => {
    setScreen('chat');
    await ws.actions.selectProject(project);
    try {
      const list = await window.alia.request('conversations.list', { projectPath: project });
      const ids = pipelineSessions();
      const hit = list.find((c) => ids.includes(c.id));
      if (hit) await ws.actions.openConversation(hit);
    } catch {
      /* the project is open at least */
    }
  };
  const startPipeline = (project: string, inputs: PipelineInputRef[]) =>
    runInNewConversation(project, async (sessionId) => {
      const result = await window.alia.request('pipeline.start', { sessionId, inputs });
      return result.started ? undefined : result.problems;
    }) as Promise<IntakeProblem[] | undefined>;
  const resumePipeline = (project: string) =>
    runInNewConversation(project, async (sessionId) => {
      const result = await window.alia.request('pipeline.resume', { sessionId });
      return result.started ? undefined : t.pipeline.stop.start;
    }) as Promise<string | undefined>;

  useEffect(() => {
    try {
      window.localStorage.setItem('alia.panelOpen', panelOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [panelOpen]);

  return (
    <div className="app">
      <TitleBar />
      <div className="shell">
        <Sidebar
          projects={ws.projects}
          currentProject={ws.currentProject}
          conversations={ws.conversations}
          activeId={screen === 'chat' ? ws.open?.info.id : undefined}
          pipelineActive={screen === 'pipeline'}
          pipelines={ws.pipelines}
          states={ws.states}
          projectMarks={ws.projectMarks}
          query={ws.query}
          results={ws.results}
          searching={ws.searching}
          now={now}
          onQuery={ws.actions.setQuery}
          onNewConversation={() => {
            setScreen('chat');
            ws.actions.newConversation();
          }}
          onOpenPipeline={openPipeline}
          onNewPipeline={() => {
            setIntakeNotice({ problems: [] });
            setScreen('pipeline');
          }}
          onOpenFolder={() => {
            setScreen('chat');
            void ws.actions.openFolder();
          }}
          onSelectProject={(p) => {
            setScreen('chat');
            void ws.actions.selectProject(p);
          }}
          onOpenConversation={(info) => {
            setScreen('chat');
            void (info.workspace === ws.currentProject ? ws.actions.openConversation(info) : ws.actions.selectProject(info.workspace, info));
          }}
          onRename={ws.actions.rename}
          onDelete={ws.actions.remove}
          onOpenSettings={() => setScreen('settings')}
        />
        <main className={`content ${screen === 'chat' && ws.open ? 'pane-host' : ''}`}>
          {ws.error && (
            <p className="banner error-banner" role="alert">
              {t.common.errorGeneric(ws.error)}{' '}
              <button type="button" className="btn small" onClick={ws.actions.dismissError}>
                OK
              </button>
            </p>
          )}
          {screen === 'settings' ? (
            <SettingsScreen onClose={() => setScreen('chat')} onSaved={(s) => { setSettings(s); ws.actions.ensureDraft(); }} onProjectsChanged={ws.actions.refreshProjects} />
          ) : screen === 'pipeline' ? (
            <PipelineIntake
              projects={ws.projects}
              project={ws.currentProject}
              onProject={(p) => void ws.actions.selectProject(p)}
              rows={intakeRows}
              setRows={(update) => setIntakeRows(update)}
              notice={intakeNotice}
              setNotice={setIntakeNotice}
              onStart={startPipeline}
              onResume={resumePipeline}
              refreshKey={pipelineEpoch}
            />
          ) : ws.open ? (
            <ConversationPane
              key={`${ws.open.info.id}:${ws.open.epoch ?? 0}`}
              conversation={ws.open}
              states={ws.states}
              loading={ws.opening}
              configured={settings?.configured ?? true}
              onOpenSettings={() => setScreen('settings')}
              onStarted={ws.actions.markStarted}
              interactions={inter.pending}
              onRespond={(id, response) => void inter.respond(id, response)}
              defaultOwner={settings?.displayName ?? ''}
              panelOpen={panelOpen}
              onTogglePanel={() => setPanelOpen((open) => !open)}
              pipeline={isPipelineSession(ws.open.info.id)}
              intro={<Home name={settings?.displayName ?? ''} project={ws.currentProject} now={now} configured={settings?.configured ?? true} onSetup={() => setScreen('settings')} />}
            />
          ) : (
            <Home name={settings?.displayName ?? ''} project={ws.currentProject} now={now} configured={settings?.configured ?? true} onSetup={() => setScreen('settings')} />
          )}
        </main>
      </div>
      {ws.trustPrompt && <TrustDialog prompt={ws.trustPrompt} onAnswer={(trusted) => void ws.actions.answerTrust(trusted)} />}
    </div>
  );
}
