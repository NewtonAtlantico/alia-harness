import { useEffect, useRef, useState } from 'react';
import type { IntakeProblem, PipelineFlow, PipelineInputRef, SettingsView } from '../../shared/ipc';
import { ConversationPane } from './components/ConversationPane';
import { Home } from './components/Home';
import { PipelineIntake, type IntakeNotice } from './components/PipelineIntake';
import { SettingsScreen } from './components/SettingsScreen';
import { Sidebar } from './components/Sidebar';
import { HowItWorks } from './components/simple/HowItWorks';
import { ModeToggle } from './components/simple/ModeToggle';
import { SimpleNewProject, type NewProjectForm } from './components/simple/SimpleNewProject';
import { SimpleProject } from './components/simple/SimpleProject';
import { SimpleSidebar } from './components/simple/SimpleSidebar';
import { TitleBar } from './components/TitleBar';
import { TrustDialog } from './components/TrustDialog';
import { useInteractions } from './hooks/useInteractions';
import { useWorkspace } from './hooks/useWorkspace';
import { t } from './i18n/pt-BR';
import { toInputs, type IntakeRow } from './lib/intake';
import { isPipelineSession, markPipelineSession, pipelineSessions } from './lib/pipelineSessions';
import { isSimpleProject, readMode, writeMode, type Mode } from './lib/simple';
import { stateOf } from './lib/sessionStates';

type Screen = 'chat' | 'settings' | 'pipeline';

/** Two frames: long enough for a screen that was just switched to to be on the page and listening. */
const nextFrames = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

const FLOW_KEY = 'alia.flow';
const OWNERS_KEY = 'alia.techOwners';

function remembered(key: string): string | undefined {
  try {
    return window.localStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}
function remember(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* the choice is only forgotten */
  }
}
const readOwners = (): string[] => {
  try {
    const list: unknown = JSON.parse(remembered(OWNERS_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

const emptyForm: NewProjectForm = { name: '', request: '', owner: '' };

/** The app: title bar, the sidebar (projects, conversations, search, pipelines) and the screen beside it, in the technical or the simple view. */
export function App() {
  const [screen, setScreen] = useState<Screen>('chat');
  const [mode, setModeState] = useState<Mode>(readMode);
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
  const [flows, setFlows] = useState<PipelineFlow[]>([]);
  const [flowId, setFlowId] = useState(() => remembered(FLOW_KEY) ?? '');
  const [form, setForm] = useState<NewProjectForm>(emptyForm);
  const [owners, setOwners] = useState<string[]>(readOwners);
  const [simpleStarting, setSimpleStarting] = useState(false);
  const [showHow, setShowHow] = useState(false);
  /** A project folder created for a start the engine then refused: trying again with the same name uses it instead of making another. */
  const draftProject = useRef<{ name: string; request: string; path: string; requestFile?: string } | undefined>(undefined);
  const inter = useInteractions();
  const ws = useWorkspace(() => setScreen('chat'), inter.pending);
  const simple = mode === 'simple';

  const setMode = (next: Mode) => {
    writeMode(next);
    setModeState(next);
  };

  useEffect(() => {
    window.alia.request('settings.get', {}).then((s) => {
      setSettings(s);
      if (!s.configured) setScreen('settings'); // first run: nothing works until the endpoint and key are set
    });
    window.alia
      .request('pipeline.flows', {})
      .then(setFlows)
      .catch(() => {});
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

  // The flow chosen is kept; one that no longer exists (or none chosen yet) falls back to the first.
  const chosenFlow = flows.find((f) => f.id === flowId)?.id ?? flows[0]?.id ?? '';
  const chooseFlow = (id: string) => {
    setFlowId(id);
    remember(FLOW_KEY, id);
  };

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
      setIntakeNotice({ problems: [], error: errorText(err) });
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
  const startPipeline = (project: string, inputs: PipelineInputRef[], flow: string) =>
    runInNewConversation(project, async (sessionId) => {
      const result = await window.alia.request('pipeline.start', { sessionId, inputs, flow });
      return result.started ? undefined : result.problems;
    }) as Promise<IntakeProblem[] | undefined>;
  const resumePipeline = (project: string) =>
    runInNewConversation(project, async (sessionId) => {
      const result = await window.alia.request('pipeline.resume', { sessionId });
      return result.started ? undefined : t.pipeline.stop.start;
    }) as Promise<string | undefined>;

  /**
   * "Começar" in the simple view: the project's folder is made from its name (the person never picks one), what they asked for
   * and who answers the technical questions are kept with it, and the pipeline starts with the request and the files.
   */
  const startSimple = async () => {
    const name = form.name.trim();
    const request = form.request.trim();
    const owner = form.owner.trim();
    setSimpleStarting(true);
    setIntakeNotice({ problems: [] });
    try {
      let draft = draftProject.current && draftProject.current.name === name && draftProject.current.request === request ? draftProject.current : undefined;
      if (!draft) {
        const created = await window.alia.request('projects.create', { name, ...(request ? { request } : {}) });
        draft = { name, request, path: created.path, ...(created.requestFile ? { requestFile: created.requestFile } : {}) };
        draftProject.current = draft;
      }
      await window.alia.request('projectMeta.set', { projectPath: draft.path, patch: { name, ...(request ? { request } : {}), ...(owner ? { owner } : {}) } });
      await ws.actions.refreshProjects();
      const inputs: PipelineInputRef[] = [...(draft.requestFile ? [{ path: draft.requestFile }] : []), ...toInputs(intakeRows)];
      const project = draft.path;
      const refused = await runInNewConversation(project, async (sessionId) => {
        const result = await window.alia.request('pipeline.start', { sessionId, inputs, flow: chosenFlow, projectName: name });
        return result.started ? undefined : result.problems;
      });
      if (refused) return;
      draftProject.current = undefined;
      setForm(emptyForm);
      if (owner) {
        const next = [owner, ...owners.filter((o) => o !== owner)].slice(0, 20);
        setOwners(next);
        remember(OWNERS_KEY, JSON.stringify(next));
      }
      await ws.actions.refreshProjects();
    } catch (err) {
      setScreen('pipeline');
      setIntakeNotice({ problems: [], error: errorText(err) });
    } finally {
      setSimpleStarting(false);
    }
  };

  /** The simple view opens a project on the conversation that runs it, which it needs to act on the pipeline. */
  const openSimple = async (project: string) => {
    await openPipeline(project);
  };

  useEffect(() => {
    try {
      window.localStorage.setItem('alia.panelOpen', panelOpen ? '1' : '0');
    } catch {
      /* ignore */
    }
  }, [panelOpen]);

  const brief = ws.currentProject ? ws.pipelines[ws.currentProject] : undefined;
  const onSimpleProject = !!ws.open && !!ws.currentProject && ws.open.info.workspace.toLowerCase() === ws.currentProject.toLowerCase() && (isSimpleProject(brief) || isPipelineSession(ws.open.info.id));
  // The simple view works on the conversation of the project as on a pipeline's: the technical view then shows it with its stepper.
  const simpleSession = simple && onSimpleProject && ws.open ? ws.open.info.id : undefined;
  useEffect(() => {
    if (simpleSession) markPipelineSession(simpleSession);
  }, [simpleSession]);
  const currentFlow = flows.find((f) => f.id === (brief?.flow ?? chosenFlow)) ?? flows[0];
  const toggle = <ModeToggle mode={mode} onChange={setMode} />;

  return (
    <div className={`app ${simple ? 'simple-mode' : ''}`}>
      <TitleBar simple={simple} toggle={simple ? undefined : toggle} />
      <div className="shell">
        {simple ? (
          <SimpleSidebar
            projects={ws.projects}
            pipelines={ws.pipelines}
            currentProject={onSimpleProject ? ws.currentProject : undefined}
            creating={screen === 'pipeline' || (screen === 'chat' && !onSimpleProject)}
            name={settings?.displayName ?? ''}
            organization={settings?.organization ?? ''}
            onNew={() => {
              setIntakeNotice({ problems: [] });
              setScreen('pipeline');
            }}
            onOpen={(project) => void openSimple(project)}
            onHow={() => setShowHow(true)}
            onSettings={() => setScreen('settings')}
          />
        ) : (
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
        )}
        <main className={`content ${screen === 'chat' && ws.open && !simple ? 'pane-host' : ''} ${simple ? 'simple-content' : ''}`}>
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
          ) : simple && screen === 'chat' && onSimpleProject && ws.open ? (
            <SimpleProject
              key={ws.open.info.id}
              project={ws.currentProject!}
              sessionId={ws.open.info.id}
              brief={brief}
              me={settings?.displayName ?? ''}
              running={stateOf(ws.states, ws.open.info.id).running}
              interactions={[...inter.pending]}
              onRespond={(id, response) => void inter.respond(id, response)}
              onStarted={ws.actions.markStarted}
              onTechnical={() => setMode('technical')}
              onMetaChanged={() => void ws.actions.refreshProjects()}
              mode={mode}
              onMode={setMode}
            />
          ) : simple ? (
            <SimpleNewProject
              flows={flows}
              flowId={chosenFlow}
              onFlow={chooseFlow}
              form={form}
              setForm={setForm}
              rows={intakeRows}
              setRows={(update) => setIntakeRows(update)}
              owners={owners}
              notice={intakeNotice}
              setNotice={setIntakeNotice}
              starting={simpleStarting}
              onStart={() => void startSimple()}
              onCancel={() => {
                setIntakeRows([]);
                setForm(emptyForm);
                setIntakeNotice({ problems: [] });
                setScreen('chat');
              }}
              mode={mode}
              onMode={setMode}
            />
          ) : screen === 'pipeline' ? (
            <PipelineIntake
              projects={ws.projects}
              project={ws.currentProject}
              onProject={(p) => void ws.actions.selectProject(p)}
              rows={intakeRows}
              setRows={(update) => setIntakeRows(update)}
              notice={intakeNotice}
              setNotice={setIntakeNotice}
              flows={flows}
              flowId={chosenFlow}
              onFlow={chooseFlow}
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
      {showHow && <HowItWorks flow={currentFlow} onClose={() => setShowHow(false)} />}
    </div>
  );
}
