import { useCallback, useEffect, useState } from 'react';
import type { Interaction, InteractionResponse, PipelineBrief, ProjectMeta } from '../../../../shared/ipc';
import { usePipelineView } from '../../hooks/usePipelineView';
import { t } from '../../i18n/pt-BR';
import { forSession } from '../../lib/interactions';
import { currentStep, screenFor, simpleSteps, simpleTitle, type Mode } from '../../lib/simple';
import { InteractionCards } from '../InteractionCards';
import { SimpleFeatures } from './SimpleFeatures';
import { SimpleHeader } from './SimpleHeader';
import { SimplePlan } from './SimplePlan';
import { SimpleQuestions } from './SimpleQuestions';
import { SimpleStatus } from './SimpleStatus';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/**
 * One project in the simple view: its four steps on top and, below, the one thing the person has to do now (answer a question,
 * confirm a feature, send the plan) or the reason there is nothing to do (the work is running, the technical owner decides). It
 * reads the same pipeline state as the technical view and changes it through the same requests.
 */
export function SimpleProject({
  project,
  sessionId,
  brief,
  me,
  running,
  interactions,
  onRespond,
  onStarted,
  onTechnical,
  onMetaChanged,
  mode,
  onMode,
}: {
  project: string;
  /** The conversation that runs this project's pipeline (the engine needs one to work in). */
  sessionId: string;
  brief?: PipelineBrief;
  /** The person (their name is recorded with what they answer). */
  me: string;
  running: boolean;
  /** Everything waiting for an answer, in every conversation; this screen shows its own. */
  interactions: Interaction[];
  onRespond: (id: string, response: InteractionResponse) => void;
  /** The engine was asked to run something in this conversation. */
  onStarted: () => void;
  /** Leaves the simple view for the technical one, on this project. */
  onTechnical: () => void;
  /** What the project keeps changed (the plan was handed over): the sidebar reads it again. */
  onMetaChanged?: () => void;
  mode: Mode;
  onMode: (mode: Mode) => void;
}) {
  const [launching, setLaunching] = useState(false);
  const [error, setError] = useState<string>();
  const [meta, setMeta] = useState<ProjectMeta | null>(brief?.meta ?? null);
  const busy = running || launching;
  const { view, reload } = usePipelineView(project, true, `${sessionId}:${busy ? 'run' : 'idle'}`);

  // The work changes the state as it goes: read it again while it runs.
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void reload(), 2500);
    return () => clearInterval(timer);
  }, [running, reload]);

  // "Continuar" and the like ask the engine and the run starts a moment later: until it does, the screen says it is working.
  useEffect(() => {
    if (running) setLaunching(false);
  }, [running]);
  useEffect(() => {
    if (!launching) return;
    const timer = setTimeout(() => setLaunching(false), 8000);
    return () => clearTimeout(timer);
  }, [launching]);

  useEffect(() => {
    let current = true;
    window.alia
      .request('projectMeta.get', { projectPath: project })
      .then((m) => {
        if (!current) return;
        setMeta(m);
        if (JSON.stringify(m ?? null) !== JSON.stringify(brief?.meta ?? null)) onMetaChanged?.();
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [project, busy]);

  const resume = useCallback(async () => {
    setError(undefined);
    setLaunching(true);
    try {
      await window.alia.request('pipeline.resume', { sessionId });
      onStarted();
    } catch (err) {
      setLaunching(false);
      setError(errorText(err));
    }
  }, [sessionId, onStarted]);

  const pause = () => void window.alia.request('session.cancel', { sessionId });

  const approveAndGo = async () => {
    setError(undefined);
    setLaunching(true);
    try {
      await window.alia.request('pipeline.approveGate', { sessionId, gate: 'G1' });
      await reload();
      await window.alia.request('pipeline.resume', { sessionId });
      onStarted();
    } catch (err) {
      setLaunching(false);
      setError(errorText(err));
    }
  };

  const openFile = (file: string) => void window.alia.request('projects.openFile', { projectPath: project, path: file }).catch((err) => setError(errorText(err)));

  const title = simpleTitle(project, brief ?? (view?.state ? ({ exists: true, project: view.state.project, summary: '', state: 'not_started' } as PipelineBrief) : undefined));
  const mine = forSession(interactions, sessionId);
  const owner = meta?.owner ?? '';
  const steps = view ? simpleSteps(view, busy) : undefined;
  const screen = view ? screenFor(view, busy) : undefined;
  const stepTitle = (steps && currentStep(steps)?.title) ?? '';
  const names = view?.status.staleInputs.map((i) => i.name) ?? [];
  const body = () => {
    if (!view || !screen) return <p className="hint">{t.common.loading}</p>;
    switch (screen.kind) {
      case 'questions':
        return <SimpleQuestions key={screen.gate} view={view} sessionId={sessionId} gate={screen.gate} me={me} owner={owner} onChanged={reload} onResume={resume} onOpenFile={openFile} />;
      case 'features':
        return <SimpleFeatures key={sessionId} view={view} sessionId={sessionId} by={me.trim() || 'Usuário'} onChanged={reload} onResume={resume} onStarted={onStarted} onTechnical={onTechnical} />;
      case 'plan':
        return <SimplePlan view={view} sessionId={sessionId} project={project} title={title} handedOff={meta?.handedOff} running={busy} onStarted={onStarted} onTechnical={onTechnical} />;
      default:
        return <SimpleStatus screen={screen} step={stepTitle} owner={owner} names={names} busy={launching} error={error} onPause={pause} onResume={() => void resume()} onGo={() => void approveAndGo()} onTechnical={onTechnical} />;
    }
  };

  return (
    <section className="simple-screen simple-project" aria-labelledby="simple-title" data-testid="simple-project-screen">
      <SimpleHeader title={title} client={view?.flow?.name} mode={mode} onMode={onMode} steps={steps} />
      <div className="simple-body">
        {mine.length > 0 && (
          <div className="simple-interactions" data-testid="simple-interactions">
            <InteractionCards interactions={mine} defaultOwner={me} onRespond={onRespond} />
          </div>
        )}
        {body()}
        {error && screen && ['questions', 'features', 'plan'].includes(screen.kind) && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}
