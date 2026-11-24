import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { JiraTarget, McpProjectList, McpServerInput, McpServerSummary, McpTestResult } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';
import {
  atlassianInput,
  buildServerInput,
  buildTarget,
  emptyForm,
  failureText,
  formSignature,
  isProjectKey,
  needsSecureStorage,
  normalizeKey,
  projectMode,
  savedServer,
  validateForm,
  type EnvRow,
  type OtherForm,
} from '../lib/jira';
import { Dialog } from './Dialog';

const errorText = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

type Step = 'account' | 'other' | 'project';
type Run =
  | { kind: 'idle' }
  | { kind: 'running'; what: 'test' | 'signin' | 'save' }
  | { kind: 'done'; result: McpTestResult; signature: string }
  | { kind: 'failed'; text: string; signature: string };

interface Verified {
  input: McpServerInput;
  account?: string;
}

interface Saved {
  id: string;
  label: string;
  account?: string;
}

type Projects = { state: 'loading' } | { state: 'ready'; list: McpProjectList } | { state: 'failed' };

/** What a test or sign-in said, for the person: green with what the server can do, or red with why it cannot be used. */
function ResultPanel({ run }: { run: Run }) {
  if (run.kind === 'failed') {
    return (
      <div className="jira-result bad" role="alert" data-testid="jira-result-bad">
        <strong>{t.jira.dialog.result.badTitle}</strong>
        <p>{run.text}</p>
      </div>
    );
  }
  if (run.kind !== 'done') return null;
  const r = run.result;
  const caps = (
    <ul className="jira-caps">
      <Cap on={r.capabilities.createsIssues} label={t.jira.dialog.result.createsIssues} />
      <Cap on={r.capabilities.listsProjects} label={t.jira.dialog.result.listsProjects} />
      {!r.ok && <Cap on={r.capabilities.linksIssues} label={t.jira.dialog.result.linksIssues} />}
    </ul>
  );
  if (r.ok) {
    return (
      <div className="jira-result ok" role="status" data-testid="jira-result-ok">
        <strong>{t.jira.dialog.result.okTitle}</strong> <span>{t.jira.dialog.result.okMeta(r.toolCount, r.account)}</span>
        {caps}
        {!r.capabilities.linksIssues && <p className="jira-warn">{t.jira.dialog.result.noLinks}</p>}
      </div>
    );
  }
  return (
    <div className="jira-result bad" role="alert" data-testid="jira-result-bad">
      <strong>{r.reason === 'no_issue_tool' ? t.jira.dialog.result.noIssueTitle : t.jira.dialog.result.badTitle}</strong> {r.toolCount > 0 && <span>{t.jira.dialog.result.badMeta(r.toolCount)}</span>}
      {r.toolCount > 0 && caps}
      <p>{failureText(r.reason ?? 'other', r.toolCount)}</p>
      {r.message && <p className="hint">{t.jira.dialog.result.detail(r.message)}</p>}
    </div>
  );
}

function Cap({ on, label }: { on: boolean; label: string }) {
  return (
    <li className={on ? 'on' : 'off'}>
      <span className="mark" aria-hidden="true">
        {on ? '✓' : '✗'}
      </span>
      <span>{label}</span>
      <span className="sr-only">{on ? t.jira.dialog.result.yes : t.jira.dialog.result.no}</span>
    </li>
  );
}

/**
 * Connects the project to Jira through an MCP server, in two steps: the account (Atlassian's official server, or another one over HTTP
 * or as a local command, tested before it can be used) and the project the tasks go to. The server is saved when the account step
 * passes, because only a connected server can list its projects; closing before the end undoes that. With `existing` it opens at
 * the project step, to change the project of a connection that is already there. `onConnected` runs once the target is saved.
 */
export function JiraConnectDialog({ projectPath, existing, onClose, onConnected }: { projectPath: string; existing?: { server: McpServerSummary; target: JiraTarget | null }; onClose: () => void; onConnected: () => void }) {
  const titleId = useId();
  const api = window.alia.request;
  const alive = useRef(true);
  const created = useRef<string | undefined>(undefined);
  const finished = useRef(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);

  const [step, setStep] = useState<Step>(existing ? 'project' : 'account');
  const [choice, setChoice] = useState<'atlassian' | 'other'>('atlassian');
  const [form, setForm] = useState<OtherForm>(emptyForm);
  const [showErrors, setShowErrors] = useState(false);
  const [run, setRun] = useState<Run>({ kind: 'idle' });
  const [verified, setVerified] = useState<Verified>();
  const [secure, setSecure] = useState(true);
  const [saved, setSaved] = useState<Saved | undefined>(existing ? { id: existing.server.id, label: existing.server.label } : undefined);
  const [projects, setProjects] = useState<Projects>({ state: 'loading' });
  const [key, setKey] = useState(existing?.target?.projectKey ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    alive.current = true;
    void api('mcp.get', {})
      .then((v) => alive.current && setSecure(v.secureStorage))
      .catch(() => undefined);
    return () => {
      alive.current = false;
    };
  }, [api]);

  // A new step replaces the buttons that had the focus: it goes to the step's heading, so the keyboard keeps its place in the dialog.
  useEffect(() => {
    if (firstRender.current) firstRender.current = false;
    else headingRef.current?.focus();
  }, [step]);

  const loadProjects = useCallback(
    async (serverId: string, current?: string) => {
      setProjects({ state: 'loading' });
      try {
        const list = await api('mcp.projects', { serverId });
        if (!alive.current) return;
        setProjects({ state: 'ready', list });
        if (!current && projectMode(list) === 'select') setKey(list.projects[0].key);
      } catch {
        if (alive.current) setProjects({ state: 'failed' });
      }
    },
    [api]
  );

  useEffect(() => {
    if (existing) void loadProjects(existing.server.id, existing.target?.projectKey);
    // Only once, for the connection that is already there.
  }, []);

  const close = () => {
    // Undo what this dialog saved if it was never finished (a server that was there before is left alone).
    if (!finished.current && created.current) void api('mcp.remove', { id: created.current }).catch(() => undefined);
    onClose();
  };

  const busy = run.kind === 'running' || saving;
  const waiting = run.kind === 'running' ? run.what : undefined;

  /** Saves the server that passed and moves on to choosing the project. */
  const enterProject = async (input: McpServerInput, account: string | undefined, sig: string) => {
    setRun({ kind: 'running', what: 'save' });
    try {
      const before = await api('mcp.get', {}).catch(() => undefined);
      const view = await api('mcp.save', { server: input });
      if (!alive.current) return;
      const server = savedServer(before, view, input.id);
      if (!server || !server.connected) {
        setRun({ kind: 'failed', text: failureText('other'), signature: sig });
        return;
      }
      if (before && !before.servers.some((s) => s.id === server.id)) created.current = server.id;
      setSaved({ id: server.id, label: server.label, account });
      setKey('');
      setError(undefined);
      setStep('project');
      setRun({ kind: 'idle' });
      void loadProjects(server.id);
    } catch (err) {
      if (alive.current) setRun({ kind: 'failed', text: errorText(err), signature: sig });
    }
  };

  const signInAtlassian = async () => {
    const input = atlassianInput();
    setRun({ kind: 'running', what: 'signin' });
    try {
      const r = await api('mcp.signIn', { server: input });
      if (!alive.current) return;
      if (!r.ok) return setRun({ kind: 'done', result: r, signature: 'atlassian' });
      await enterProject(input, r.account, 'atlassian');
    } catch (err) {
      if (alive.current) setRun({ kind: 'failed', text: errorText(err), signature: 'atlassian' });
    }
  };

  const checked = validateForm(form);
  const signature = checked.ok ? formSignature(form) : undefined;
  // A result holds only for the values it was run with: any edit makes it stale.
  const current = (run.kind === 'done' || run.kind === 'failed') && run.signature === signature ? run : undefined;
  const passed = current?.kind === 'done' && current.result.ok ? current.result : undefined;
  const oauth = form.kind === 'http' && form.auth === 'oauth';
  const blockedBySecrets = !secure && (choice === 'atlassian' || needsSecureStorage(form));

  const testOther = async () => {
    setShowErrors(true);
    if (!checked.ok || !signature) return;
    const input = buildServerInput(form);
    setRun({ kind: 'running', what: oauth ? 'signin' : 'test' });
    try {
      const r = await api(oauth ? 'mcp.signIn' : 'mcp.test', { server: input });
      if (!alive.current) return;
      setRun({ kind: 'done', result: r, signature });
      if (r.ok) setVerified({ input, account: r.account });
    } catch (err) {
      if (alive.current) setRun({ kind: 'failed', text: errorText(err), signature });
    }
  };

  const edit = (patch: Partial<OtherForm>) => setForm((f) => ({ ...f, ...patch }));
  const editRow = (i: number, patch: Partial<EnvRow>) => setForm((f) => ({ ...f, env: f.env.map((r, n) => (n === i ? { ...r, ...patch } : r)) }));

  const keyValue = normalizeKey(key);
  const mode = projectMode(projects.state === 'ready' ? projects.list : undefined);
  const inList = projects.state === 'ready' && projects.list.projects.some((p) => normalizeKey(p.key) === keyValue);
  const keyOk = mode === 'select' ? inList : isProjectKey(key);
  const projectsReady = projects.state !== 'loading';

  const save = async () => {
    if (!saved || !keyOk) return;
    setSaving(true);
    setError(undefined);
    try {
      const list = projects.state === 'ready' ? projects.list.projects : [];
      const site = existing?.target?.serverId === saved.id ? existing.target.site : undefined;
      await api('jira.setTarget', { projectPath, target: buildTarget(saved.id, keyValue, list, site) });
      finished.current = true;
      onConnected();
    } catch (err) {
      if (alive.current) {
        setError(t.jira.failed(errorText(err)));
        setSaving(false);
      }
    }
  };

  const steps = [
    { id: 'account', label: t.jira.dialog.steps.account },
    { id: 'project', label: t.jira.dialog.steps.project },
  ] as const;
  const stepNow = step === 'project' ? 'project' : 'account';

  const heading = step === 'project' ? t.jira.dialog.project.title : step === 'other' ? t.jira.dialog.other.title : t.jira.dialog.title;

  return (
    <Dialog labelledBy={titleId} onCancel={close}>
      <div className="jira-dialog" aria-busy={busy} data-testid="jira-dialog" data-step={step}>
        <h2 id={titleId} ref={headingRef} tabIndex={-1}>
          {heading}
        </h2>
        <ol className="jira-steps" aria-label={t.jira.dialog.stepsLabel}>
          {steps.map((s, i) => (
            <li key={s.id} className={s.id === stepNow ? 'current' : stepNow === 'project' ? 'done' : ''} aria-current={s.id === stepNow ? 'step' : undefined}>
              <span className="step-n" aria-hidden="true">
                {i + 1}
              </span>
              {s.label}
            </li>
          ))}
        </ol>

        {!secure && (
          <p className="jira-warn" role="note" data-testid="jira-no-secure">
            {t.jira.dialog.secureStorage}
          </p>
        )}

        {step === 'account' && (
          <>
            <p>{t.jira.dialog.account.intro}</p>
            <fieldset className="jira-choices" disabled={busy}>
              <legend>{t.jira.dialog.account.server}</legend>
              {(['atlassian', 'other'] as const).map((c) => (
                <label key={c} className={`choice ${choice === c ? 'selected' : ''}`}>
                  <input type="radio" name="jira-server" value={c} checked={choice === c} onChange={() => setChoice(c)} data-testid={`jira-choice-${c}`} />
                  <span>
                    <strong>{c === 'atlassian' ? t.jira.dialog.account.atlassian : t.jira.dialog.account.other}</strong>
                    <span className="hint">{c === 'atlassian' ? t.jira.dialog.account.atlassianHint : t.jira.dialog.account.otherHint}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <div className="jira-can">
              <div>
                <h3>{t.jira.dialog.account.can}</h3>
                <ul className="tick-list">
                  {t.jira.dialog.account.canItems.map((item) => (
                    <li key={item}>
                      <span className="mark" aria-hidden="true">
                        ✓
                      </span>{' '}
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3>{t.jira.dialog.account.cannot}</h3>
                <ul className="tick-list cross-list">
                  {t.jira.dialog.account.cannotItems.map((item) => (
                    <li key={item}>
                      <span className="mark" aria-hidden="true">
                        ✗
                      </span>{' '}
                      {item}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {choice === 'atlassian' && (
              <>
                <ResultPanel run={(run.kind === 'done' || run.kind === 'failed') && run.signature === 'atlassian' ? run : { kind: 'idle' }} />
                {waiting && (
                  <p className="hint jira-wait" role="status" data-testid="jira-waiting">
                    <span className="mark spinner" aria-hidden="true" /> {waiting === 'save' ? t.jira.dialog.account.saving : t.jira.dialog.account.waiting}
                  </p>
                )}
              </>
            )}
            <div className="dialog-actions">
              {choice === 'atlassian' && !busy && <span className="hint grow">{t.jira.dialog.account.signInHint}</span>}
              <button type="button" className="btn" onClick={close} data-testid="jira-cancel">
                {t.jira.dialog.cancel}
              </button>
              {choice === 'atlassian' ? (
                <button type="button" className="btn primary" disabled={busy || blockedBySecrets} onClick={() => void signInAtlassian()} data-autofocus data-testid="jira-signin">
                  {t.jira.dialog.account.signIn}
                </button>
              ) : (
                <button
                  type="button"
                  className="btn primary"
                  disabled={busy}
                  onClick={() => {
                    setRun({ kind: 'idle' });
                    setStep('other');
                  }}
                  data-testid="jira-next"
                >
                  {t.jira.dialog.account.next}
                </button>
              )}
            </div>
          </>
        )}

        {step === 'other' && (
          <>
            <p>{form.kind === 'http' ? t.jira.dialog.other.intro : t.jira.dialog.other.introLocal}</p>
            <div className="field">
              <span id="jira-how">{t.jira.dialog.other.how}</span>
              <div className="mode-toggle jira-seg" role="group" aria-labelledby="jira-how">
                {(['http', 'stdio'] as const).map((k) => (
                  <button key={k} type="button" aria-pressed={form.kind === k} disabled={busy} onClick={() => edit({ kind: k })} data-testid={`jira-kind-${k}`}>
                    {t.jira.dialog.other[k]}
                  </button>
                ))}
              </div>
            </div>

            {form.kind === 'http' ? (
              <>
                <div className="field">
                  <label htmlFor="jira-url">{t.jira.dialog.other.url}</label>
                  <input id="jira-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} placeholder={t.jira.dialog.other.urlPlaceholder} value={form.url} disabled={busy} aria-invalid={showErrors && !!checked.errors.url} aria-describedby={showErrors && checked.errors.url ? 'jira-url-err' : undefined} onChange={(e) => edit({ url: e.target.value })} data-autofocus />
                  {showErrors && checked.errors.url && (
                    <span id="jira-url-err" className="error" role="alert">
                      {checked.errors.url}
                    </span>
                  )}
                </div>
                <fieldset className="jira-auth" disabled={busy}>
                  <legend>{t.jira.dialog.other.auth}</legend>
                  {(['oauth', 'token', 'none'] as const).map((a) => (
                    <label key={a}>
                      <input type="radio" name="jira-auth" value={a} checked={form.auth === a} onChange={() => edit({ auth: a })} data-testid={`jira-auth-${a}`} />{' '}
                      {a === 'oauth' ? t.jira.dialog.other.authOauth : a === 'token' ? t.jira.dialog.other.authToken : t.jira.dialog.other.authNone}
                    </label>
                  ))}
                </fieldset>
                {form.auth === 'token' && (
                  <div className="field">
                    <label htmlFor="jira-token">{t.jira.dialog.other.token}</label>
                    <input id="jira-token" type="password" autoComplete="off" spellCheck={false} value={form.token} disabled={busy} aria-invalid={showErrors && !!checked.errors.token} aria-describedby="jira-token-hint" onChange={(e) => edit({ token: e.target.value })} />
                    <span id="jira-token-hint" className="hint">
                      {t.jira.dialog.other.tokenHint}
                    </span>
                    {showErrors && checked.errors.token && (
                      <span className="error" role="alert">
                        {checked.errors.token}
                      </span>
                    )}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="field">
                  <label htmlFor="jira-command">{t.jira.dialog.other.command}</label>
                  <input id="jira-command" className="mono" autoComplete="off" spellCheck={false} placeholder={t.jira.dialog.other.commandPlaceholder} value={form.command} disabled={busy} aria-invalid={showErrors && !!checked.errors.command} onChange={(e) => edit({ command: e.target.value })} data-autofocus />
                  {showErrors && checked.errors.command && (
                    <span className="error" role="alert">
                      {checked.errors.command}
                    </span>
                  )}
                </div>
                <div className="field">
                  <label htmlFor="jira-args">{t.jira.dialog.other.args}</label>
                  <input id="jira-args" className="mono" autoComplete="off" spellCheck={false} placeholder={t.jira.dialog.other.argsPlaceholder} value={form.args} disabled={busy} aria-invalid={showErrors && !!checked.errors.args} aria-describedby="jira-args-hint" onChange={(e) => edit({ args: e.target.value })} />
                  <span id="jira-args-hint" className="hint">
                    {t.jira.dialog.other.argsHint}
                  </span>
                  {showErrors && checked.errors.args && (
                    <span className="error" role="alert">
                      {checked.errors.args}
                    </span>
                  )}
                </div>
                <fieldset className="jira-env" disabled={busy}>
                  <legend>{t.jira.dialog.other.env}</legend>
                  {form.env.map((row, i) => (
                    <div key={i} className="jira-env-row" data-testid="jira-env-row">
                      <input className="mono" autoComplete="off" spellCheck={false} placeholder={t.jira.dialog.other.envName} aria-label={t.jira.dialog.other.envNameLabel(i + 1)} value={row.name} aria-invalid={showErrors && !!checked.errors.env[i]} onChange={(e) => editRow(i, { name: e.target.value })} />
                      <input className="mono" type={row.secret ? 'password' : 'text'} autoComplete="off" spellCheck={false} placeholder={t.jira.dialog.other.envValue} aria-label={t.jira.dialog.other.envValueLabel(i + 1)} value={row.value} onChange={(e) => editRow(i, { value: e.target.value })} />
                      <label className="jira-secret">
                        <input type="checkbox" checked={row.secret} onChange={(e) => editRow(i, { secret: e.target.checked })} /> {t.jira.dialog.other.envSecret}
                      </label>
                      <button type="button" className="icon-btn" aria-label={t.jira.dialog.other.envRemove(row.name)} onClick={() => setForm((f) => ({ ...f, env: f.env.filter((_, n) => n !== i) }))}>
                        ×
                      </button>
                      {showErrors && checked.errors.env[i] && (
                        <span className="error jira-env-err" role="alert">
                          {checked.errors.env[i]}
                        </span>
                      )}
                    </div>
                  ))}
                  <button type="button" className="link-btn" onClick={() => setForm((f) => ({ ...f, env: [...f.env, { name: '', value: '', secret: false }] }))}>
                    {t.jira.dialog.other.envAdd}
                  </button>
                </fieldset>
                <p className="jira-warn" role="note" data-testid="jira-stdio-warning">
                  <strong>{t.jira.dialog.other.warnTitle}</strong>
                  {t.jira.dialog.other.warn}
                </p>
              </>
            )}

            {waiting && (
              <p className="hint jira-wait" role="status" data-testid="jira-waiting">
                <span className="mark spinner" aria-hidden="true" /> {waiting === 'save' ? t.jira.dialog.account.saving : waiting === 'signin' ? t.jira.dialog.other.waiting : t.jira.dialog.other.testing}
              </p>
            )}
            {!waiting && current && <ResultPanel run={current} />}
            {!waiting && !current && (
              <p className="hint" data-testid="jira-not-tested">
                {oauth ? t.jira.dialog.other.notSignedIn : t.jira.dialog.other.notTested}
              </p>
            )}

            <div className="dialog-actions">
              <button type="button" className="btn" disabled={busy} onClick={() => setStep('account')} data-testid="jira-back">
                {t.jira.dialog.back}
              </button>
              <span className="grow" />
              <button type="button" className="btn" disabled={busy || (!secure && needsSecureStorage(form))} onClick={() => void testOther()} data-testid="jira-test">
                {oauth ? (current ? t.jira.dialog.other.signInAgain : t.jira.dialog.other.signIn) : current ? t.jira.dialog.other.testAgain : t.jira.dialog.other.test}
              </button>
              <button type="button" className="btn primary" disabled={busy || !passed || !verified} onClick={() => verified && signature && void enterProject(verified.input, verified.account, signature)} data-testid="jira-continue">
                {t.jira.dialog.other.next}
              </button>
            </div>
          </>
        )}

        {step === 'project' && (
          <>
            <p className="jira-account" data-testid="jira-account">
              {t.jira.dialog.project.account} <strong>{saved?.account ?? saved?.label ?? t.jira.dialog.project.accountUnknown}</strong>
            </p>

            {projects.state === 'loading' ? (
              <p className="hint jira-wait" role="status">
                <span className="mark spinner" aria-hidden="true" /> {t.jira.dialog.project.loading}
              </p>
            ) : mode === 'select' && projects.state === 'ready' ? (
              <div className="field">
                <label htmlFor="jira-project">{t.jira.dialog.project.project}</label>
                <select id="jira-project" value={inList ? keyValue : ''} onChange={(e) => setKey(e.target.value)} disabled={saving} data-testid="jira-project-select">
                  {!inList && <option value="">{t.jira.dialog.project.choose}</option>}
                  {projects.list.projects.map((p) => (
                    <option key={`${p.site ?? ''}:${p.key}`} value={p.key}>
                      {t.jira.dialog.project.option(p.name, p.key)}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="field">
                <label htmlFor="jira-key">{t.jira.dialog.project.key}</label>
                <input id="jira-key" className="mono" autoComplete="off" spellCheck={false} value={key} disabled={saving} aria-invalid={key !== '' && !isProjectKey(key)} aria-describedby="jira-key-hint" onChange={(e) => setKey(e.target.value)} data-testid="jira-project-key" />
                <span id="jira-key-hint" className="hint">
                  {projects.state === 'failed' ? t.jira.dialog.project.keyFailed : projects.state === 'ready' && !projects.list.listed ? t.jira.dialog.project.keyUnlisted : t.jira.dialog.project.keyEmpty} {t.jira.dialog.project.keyHint}
                </span>
                {key !== '' && !isProjectKey(key) && (
                  <span className="error" role="alert">
                    {t.jira.dialog.project.keyInvalid}
                  </span>
                )}
              </div>
            )}

            <h3>{t.jira.dialog.project.how}</h3>
            <table className="spec-table jira-map" data-testid="jira-map">
              <thead>
                <tr>
                  <th scope="col">{t.jira.dialog.project.colAlia}</th>
                  <th scope="col">{t.jira.dialog.project.colJira}</th>
                </tr>
              </thead>
              <tbody>
                {t.jira.dialog.project.rows.map((r) => (
                  <tr key={r.alia}>
                    <th scope="row">{r.alia}</th>
                    <td>{r.jira}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="hint">{t.jira.dialog.project.noRepeat}</p>

            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="dialog-actions">
              {existing ? (
                <button type="button" className="btn" onClick={close} data-testid="jira-cancel">
                  {t.jira.dialog.cancel}
                </button>
              ) : (
                <button type="button" className="btn" disabled={saving} onClick={() => setStep(choice === 'other' ? 'other' : 'account')} data-testid="jira-back">
                  {t.jira.dialog.back}
                </button>
              )}
              <button type="button" className="btn primary" disabled={saving || !projectsReady || !keyOk} onClick={() => void save()} data-testid="jira-save">
                {saving ? t.jira.dialog.project.saving : existing ? t.jira.dialog.project.change : t.jira.dialog.project.save}
              </button>
            </div>
          </>
        )}
      </div>
    </Dialog>
  );
}
