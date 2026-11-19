import { useEffect, useState } from 'react';
import type { SettingsView } from '../../shared/ipc';
import { ConversationPane } from './components/ConversationPane';
import { Home } from './components/Home';
import { SettingsScreen } from './components/SettingsScreen';
import { Sidebar } from './components/Sidebar';
import { TitleBar } from './components/TitleBar';
import { TrustDialog } from './components/TrustDialog';
import { useInteractions } from './hooks/useInteractions';
import { useWorkspace } from './hooks/useWorkspace';
import { t } from './i18n/pt-BR';

type Screen = 'chat' | 'settings';

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
