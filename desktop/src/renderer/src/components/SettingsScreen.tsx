import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectResult, PermissionMode, PermissionRule, ProjectInspection, SettingsView } from '../../../shared/ipc';
import { projectName } from '../lib/projectName';
import { t } from '../i18n/pt-BR';
import { Diagnostics } from './Diagnostics';

const MODES: PermissionMode[] = ['ask-commands', 'ask-dangerous', 'auto'];

interface Draft {
  displayName: string;
  organization: string;
  permissionMode: PermissionMode;
}

const toDraft = (v: SettingsView): Draft => ({ displayName: v.displayName, organization: v.organization, permissionMode: v.permissionMode });
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const message = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

/** Returns what is wrong with the form, keyed by field, in the words the user will read. */
function validate(newKey: string | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  if (newKey !== undefined && newKey.trim().length < 8) errors.key = t.settings.errors.keyShort;
  return errors;
}

export function SettingsScreen({ onClose, onSaved, onProjectsChanged }: { onClose: () => void; onSaved: (view: SettingsView) => void; onProjectsChanged?: () => void }) {
  const [view, setView] = useState<SettingsView>();
  const [draft, setDraft] = useState<Draft>();
  const [newKey, setNewKey] = useState<string>(''); // what is typed in the key field (never read back from anywhere)
  const [editingKey, setEditingKey] = useState(false);
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; text: string }>();
  const [saving, setSaving] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [connection, setConnection] = useState<ConnectResult['connection']>();
  const [recent, setRecent] = useState<string[]>([]);
  const [project, setProject] = useState('');
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [inspections, setInspections] = useState<Record<string, ProjectInspection>>({});
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    const [v, projects] = await Promise.all([window.alia.request('settings.get', {}), window.alia.request('projects.recent', {})]);
    setView(v);
    setDraft(toDraft(v));
    setRecent(projects);
    setProject((p) => p || projects[0] || '');
    const found = await Promise.all(projects.map(async (p) => [p, await window.alia.request('projects.inspect', { projectPath: p }).catch(() => undefined)] as const));
    setInspections(Object.fromEntries(found.filter((f): f is readonly [string, ProjectInspection] => !!f[1])));
    setEditingKey(!v.hasApiKey);
  }, []);

  useEffect(() => {
    load().catch((err) => setStatus({ kind: 'error', text: t.common.errorGeneric(message(err)) }));
  }, [load]);

  useEffect(() => {
    if (!project) {
      setRules([]);
      return;
    }
    window.alia.request('permissions.listForProject', { projectPath: project }).then(setRules, () => setRules([]));
  }, [project]);

  const keyPending = editingKey && newKey.trim() !== '';
  const errors = useMemo(() => validate(keyPending ? newKey : undefined), [newKey, keyPending]);
  const dirty = !!draft && !!view && (!sameDraft(draft, toDraft(view)) || keyPending);

  if (!view || !draft) return <section className="settings"><p>{t.common.loading}</p></section>;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const err = (field: string) => (showErrors ? errors[field] : undefined);

  /** Gives the key to the service. It is stored only if the service accepts it, and the models it offers are loaded. */
  const connect = async (): Promise<boolean> => {
    setConnecting(true);
    setConnection(undefined);
    try {
      const { view: next, connection: result } = await window.alia.request('settings.setApiKey', { apiKey: newKey.trim() });
      setConnection(result);
      if (!result.ok) return false;
      setNewKey('');
      setView(next);
      setEditingKey(false);
      setShowErrors(false);
      onSaved(next);
      return true;
    } catch (e) {
      setConnection({ ok: false, models: [], reason: 'other', message: message(e) });
      return false;
    } finally {
      setConnecting(false);
    }
  };

  const refreshModels = async () => {
    setConnecting(true);
    setConnection(undefined);
    try {
      const { view: next, connection: result } = await window.alia.request('settings.refreshModels', {});
      setConnection(result);
      if (result.ok) {
        setView(next);
        onSaved(next);
      }
    } catch (e) {
      setConnection({ ok: false, models: [], reason: 'other', message: message(e) });
    } finally {
      setConnecting(false);
    }
  };

  const connectFromForm = () => {
    setShowErrors(true);
    if (errors.key || !keyPending) return;
    void connect();
  };

  const save = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setStatus(undefined);
    try {
      let next = view;
      if (!sameDraft(draft, toDraft(view))) next = await window.alia.request('settings.update', { displayName: draft.displayName, organization: draft.organization, permissionMode: draft.permissionMode });
      setView(next);
      setDraft(toDraft(next));
      onSaved(next);
      // A key typed but not yet given to the service goes along with Save.
      if (keyPending && !(await connect())) return;
      setShowErrors(false);
      setStatus({ kind: 'ok', text: t.settings.saved });
    } catch (e) {
      setStatus({ kind: 'error', text: t.common.errorGeneric(message(e)) });
    } finally {
      setSaving(false);
    }
  };

  const removeKey = async () => {
    const next = await window.alia.request('settings.clearApiKey', {});
    setView(next);
    setEditingKey(true);
    setNewKey('');
    setConnection(undefined);
    onSaved(next);
  };

  const removeRule = async (rule: PermissionRule) => {
    await window.alia.request('permissions.removeForProject', { projectPath: project, command: rule.command, match: rule.match });
    setRules(await window.alia.request('permissions.listForProject', { projectPath: project }));
  };

  const setTrust = async (projectPath: string, trusted: boolean) => {
    const next = await window.alia.request('projects.setTrust', { projectPath, trusted });
    setInspections((cur) => ({ ...cur, [projectPath]: next }));
    onProjectsChanged?.();
  };

  return (
    <section className="settings" aria-labelledby="settings-title">
      <header className="settings-header">
        <h1 id="settings-title">{t.settings.title}</h1>
        <button type="button" className="btn" onClick={onClose}>{t.settings.back}</button>
      </header>

      {!view.configured && (
        <div className="banner info" role="note">
          <strong>{t.settings.firstRun.title}</strong>
          <p>{t.settings.firstRun.body}</p>
        </div>
      )}

      <div className="card">
        <h2>{t.settings.connection.title}</h2>
        <div className="field">
          <span id="key-label">{t.settings.connection.apiKey}</span>
          {!view.secureStorage && <p className="error" role="alert">{t.settings.connection.noSecureStorage}</p>}
          {view.hasApiKey && !editingKey ? (
            <div className="row">
              <span className="pill ok" data-testid="key-saved">{t.settings.connection.keySaved}</span>
              <button type="button" className="btn" onClick={() => setEditingKey(true)}>{t.settings.connection.keyReplace}</button>
              <button type="button" className="btn danger" onClick={removeKey}>{t.settings.connection.keyRemove}</button>
            </div>
          ) : (
            <div className="row">
              <input
                type="password"
                aria-labelledby="key-label"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') connectFromForm(); }}
                placeholder={t.settings.connection.keyPlaceholder}
                autoComplete="off"
                spellCheck={false}
                disabled={!view.secureStorage || connecting}
                aria-invalid={!!err('key')}
              />
              <button type="button" className="btn primary" onClick={connectFromForm} disabled={!view.secureStorage || connecting || !keyPending}>{connecting ? t.settings.connection.connecting : t.settings.connection.connect}</button>
              {view.hasApiKey && <button type="button" className="btn" onClick={() => { setEditingKey(false); setNewKey(''); }}>{t.settings.connection.keyCancel}</button>}
            </div>
          )}
          <p className="hint">{t.settings.connection.keyNote}</p>
          {err('key') && <p className="error" role="alert">{err('key')}</p>}
        </div>
        {connection && (
          <div className={`result ${connection.ok ? 'ok' : 'bad'}`} role="status" data-testid="test-result">
            {connection.ok ? t.settings.connection.ok(connection.models.length) : t.settings.connection.reasons[connection.reason ?? 'other']}
            {!connection.ok && connection.reason === 'other' && connection.message && <span className="hint"> ({connection.message})</span>}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t.settings.models.title}</h2>
        <p className="hint">{t.settings.models.hint}</p>
        {view.models.length === 0 ? (
          <p className="hint" data-testid="models-empty">{t.settings.models.empty}</p>
        ) : (
          <ul className="remote-models" data-testid="models-list" aria-label={t.settings.models.title}>
            {view.models.map((m) => (
              <li key={m.id}>
                <strong>{m.name}</strong>
                {m.name !== m.id && <code>{m.id}</code>}
              </li>
            ))}
          </ul>
        )}
        {view.hasApiKey && (
          <div className="row">
            <button type="button" className="btn" onClick={refreshModels} disabled={connecting}>{connecting && !editingKey ? t.settings.models.refreshing : t.settings.models.refresh}</button>
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t.settings.profile.title}</h2>
        <label className="field">
          <span>{t.settings.profile.name}</span>
          <input value={draft.displayName} onChange={(e) => set({ displayName: e.target.value })} aria-describedby="name-hint" />
        </label>
        <p className="hint" id="name-hint">{t.settings.profile.nameHint}</p>
        <label className="field">
          <span>{t.settings.profile.organization}</span>
          <input value={draft.organization} onChange={(e) => set({ organization: e.target.value })} />
        </label>
      </div>

      <div className="card">
        <h2>{t.settings.permissions.title}</h2>
        <p className="hint">{t.settings.permissions.hint}</p>
        <div role="radiogroup" aria-label={t.settings.permissions.title} className="modes">
          {MODES.map((mode) => (
            <label key={mode} className={`mode ${draft.permissionMode === mode ? 'selected' : ''}`}>
              <input type="radio" name="permission-mode" value={mode} checked={draft.permissionMode === mode} onChange={() => set({ permissionMode: mode })} />
              <span>
                <strong>{t.settings.permissions.modes[mode].label}</strong>
                <span className="hint">{t.settings.permissions.modes[mode].hint}</span>
              </span>
            </label>
          ))}
        </div>

        <h3>{t.settings.permissions.allowlist}</h3>
        <p className="hint">{t.settings.permissions.allowlistHint}</p>
        {recent.length === 0 ? (
          <p className="hint">{t.settings.permissions.noProjects}</p>
        ) : (
          <>
            <div className="field">
              {/* A separate label: wrapping a <select> would make every option part of its accessible name. */}
              <label htmlFor="project-select">{t.settings.permissions.project}</label>
              <select id="project-select" value={project} onChange={(e) => setProject(e.target.value)}>
                {recent.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            {rules.length === 0 ? (
              <p className="hint">{t.settings.permissions.none}</p>
            ) : (
              <ul className="rules" data-testid="rules">
                {rules.map((r) => (
                  <li key={`${r.match}:${r.command}`}>
                    <code>{r.command}</code>
                    {r.match === 'prefix' && <span className="pill">{t.settings.permissions.prefix}</span>}
                    <button type="button" className="btn small danger" aria-label={t.settings.permissions.removeRule(r.command)} onClick={() => removeRule(r)}>{t.settings.permissions.remove}</button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>

      <div className="card">
        <h2>{t.settings.trust.title}</h2>
        <p className="hint">{t.settings.trust.hint}</p>
        {recent.length === 0 ? (
          <p className="hint">{t.settings.permissions.noProjects}</p>
        ) : (
          <ul className="rules" data-testid="trust-list">
            {recent.map((p) => {
              const info = inspections[p];
              if (!info) return null;
              const name = projectName(p);
              return (
                <li key={p}>
                  <span className="grow">
                    <strong>{name}</strong> <span className="hint">{info.projectSkills.length === 0 ? t.settings.trust.noSkills : t.settings.trust.skills(info.projectSkills.length)}</span>
                  </span>
                  <span className={`pill ${info.trust === 'trusted' ? 'ok' : ''}`}>{t.settings.trust[info.trust]}</span>
                  {info.trust === 'trusted' ? (
                    <button type="button" className="btn small danger" aria-label={t.settings.trust.revokeLabel(name)} onClick={() => setTrust(p, false)}>{t.settings.trust.revoke}</button>
                  ) : (
                    <button type="button" className="btn small" aria-label={t.settings.trust.grantLabel(name)} onClick={() => setTrust(p, true)}>{t.settings.trust.grant}</button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <p className="hint">{t.settings.trust.applies}</p>
      </div>

      <Diagnostics />

      <footer className="settings-footer">
        <button type="button" className="btn" onClick={() => { setDraft(toDraft(view)); setNewKey(''); setEditingKey(!view.hasApiKey); setShowErrors(false); setStatus(undefined); }} disabled={!dirty || saving}>{t.settings.discard}</button>
        <button type="button" className="btn primary" onClick={save} disabled={!dirty || saving}>{saving ? t.settings.saving : t.settings.save}</button>
        <div className="grow" />
        {status && <span className={status.kind === 'ok' ? 'ok-text' : 'error'} role="status" data-testid="status">{status.text}</span>}
        {dirty && !status && <span className="hint">{t.settings.unsaved}</span>}
      </footer>
    </section>
  );
}
