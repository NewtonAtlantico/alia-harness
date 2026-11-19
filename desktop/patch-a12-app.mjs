import fs from 'node:fs';
function edit(f, fn) { let s = fs.readFileSync(f, 'utf8'); const crlf = s.includes('\r\n'); s = s.replace(/\r\n/g, '\n'); s = fn(s); fs.writeFileSync(f, crlf ? s.replace(/\n/g, '\r\n') : s); }
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 80)); return s.replace(a, () => b); };
edit('src/renderer/src/App.tsx', (s) => {
  s = rep(s, "import type { IntakeRow } from './lib/intake';", "import type { IntakeRow } from './lib/intake';\nimport { isPipelineSession, markPipelineSession, pipelineSessions } from './lib/pipelineSessions';");
  s = rep(s, "    if (!sessionId) throw new Error(t.pipeline.startFailed('a conversa não pôde ser aberta'));\n    setScreen('chat');", "    if (!sessionId) throw new Error(t.pipeline.startFailed('a conversa não pôde ser aberta'));\n    markPipelineSession(sessionId); // this conversation shows the stepper and the gate card\n    setScreen('chat');");
  s = rep(s, "              panelOpen={panelOpen}\n              onTogglePanel={() => setPanelOpen((open) => !open)}", "              panelOpen={panelOpen}\n              onTogglePanel={() => setPanelOpen((open) => !open)}\n              pipeline={isPipelineSession(ws.open.info.id)}");
  s = rep(s, "          onNewPipeline={() => {", `          onOpenPipeline={openPipeline}
          onNewPipeline={() => {`);
  s = rep(s, "  const startPipeline = (project: string, inputs: PipelineInputRef[]) =>", `  /** A pipeline in the sidebar opens the conversation that runs it (the newest one of that project), or just the project. */
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
  const startPipeline = (project: string, inputs: PipelineInputRef[]) =>`);
  return s;
});
edit('src/renderer/src/components/Sidebar.tsx', (s) => {
  s = rep(s, "  onNewPipeline: () => void;", "  onNewPipeline: () => void;\n  /** A pipeline of the sidebar was clicked: show the conversation that runs it. */\n  onOpenPipeline: (project: string) => void;");
  s = rep(s, "onClick={() => p.onSelectProject(project)}>\n                        <span className={`chip ${chip.tone}`}", "onClick={() => p.onOpenPipeline(project)}>\n                        <span className={`chip ${chip.tone}`}");
  return s;
});
