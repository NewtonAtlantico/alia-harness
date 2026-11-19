import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ConnectionTestResult, LegacyCandidate, ModelSetting, PermissionMode, PermissionRule, ProjectInspection, SettingsView } from '../../../shared/ipc';
import { projectName } from '../lib/projectName';
import { t } from '../i18n/pt-BR';
import { Diagnostics } from './Diagnostics';

const MODES: PermissionMode[] = ['ask-commands', 'ask-dangerous', 'auto'];

interface Draft {
  displayName: string;
  organization: string;
  endpointUrl: string;
  models: ModelSetting[];
  permissionMode: PermissionMode;
}

const toDraft = (v: SettingsView): Draft => ({ displayName: v.displayName, organization: v.organization, endpointUrl: v.endpointUrl, models: v.models.map((m) => ({ ...m })), permissionMode: v.permissionMode });
const sameDraft = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);
const message = (err: unknown) => String((err as Error)?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value.trim());
    return (u.protocol === 'http:' || u.protocol === 'https:') && !!u.hostname && !u.username && !u.password;
  } catch {
    return false;
  }
}

/** Returns what is wrong with the form, keyed by field, in the words the user will read. */
function validate(draft: Draft, newKey: string | undefined): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!isHttpUrl(draft.endpointUrl)) errors.endpoint = t.settings.errors.endpoint;
  if (draft.models.length === 0) errors.models = t.settings.errors.noModels;
  const seen = new Set<string>();
  draft.models.forEach((m, i) => {
    const id = m.id.trim();
    if (!id) errors[`model-${i}-id`] = t.settings.errors.modelId;
    else if (seen.has(id)) errors[`model-${i}-id`] = t.settings.errors.duplicateId(id);
    seen.add(id);
    if (m.maxInputTokens !== undefined && (!Number.isInteger(m.maxInputTokens) || m.maxInputTokens < 1000)) errors[`model-${i}-context`] = t.settings.errors.context;
  });
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
  const [test, setTest] = useState<{ running: boolean; result?: ConnectionTestResult; needKey?: boolean }>({ running: false });
  const [legacy, setLegacy] = useState<LegacyCandidate | null>(null);
  const [recent, setRecent] = useState<string[]>([]);
  const [project, setProject] = useState('');
  const [rules, setRules] = useState<PermissionRule[]>([]);
  const [inspections, setInspections] = useState<Record<string, ProjectInspection>>({});
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    const [v, candidate, projects] = await Promise.all([window.alia.request('settings.get', {}), window.alia.request('settings.legacyCandidate', {}), window.alia.request('projects.recent', {})]);
    setView(v);
    setDraft(toDraft(v));
    setLegacy(v.configured ? null : candidate);
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
  const errors = useMemo(() => (draft ? validate(draft, keyPending ? newKey : undefined) : {}), [draft, newKey, keyPending]);
  const dirty = !!draft && !!view && (!sameDraft(draft, toDraft(view)) || keyPending);

  if (!view || !draft) return <section className="settings"><p>{t.common.loading}</p></section>;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const setModel = (i: number, patch: Partial<ModelSetting>) => set({ models: draft.models.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const err = (field: string) => (showErrors ? errors[field] : undefined);

  const save = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0) return;
    setSaving(true);
    setStatus(undefined);
    try {
      let next = await window.alia.request('settings.update', {
        displayName: draft.displayName,
        organization: draft.organization,
        endpointUrl: draft.endpointUrl.trim(),
        models: draft.models.map((m) => ({ ...m, id: m.id.trim(), name: m.name.trim() || m.id.trim() })),
        permissionMode: draft.permissionMode,
      });
      if (keyPending) next = await window.alia.request('settings.setApiKey', { apiKey: newKey.trim() });
      setNewKey('');
      setView(next);
      setDraft(toDraft(next));
      setEditingKey(!next.hasApiKey);
      setShowErrors(false);
      setLegacy(null);
      setStatus({ kind: 'ok', text: t.settings.saved });
      onSaved(next);
    } catch (e) {
      setStatus({ kind: 'error', text: t.common.errorGeneric(message(e)) });
    } finally {
      setSaving(false);
    }
  };

  const runTest = async () => {
    if (!isHttpUrl(draft.endpointUrl)) {
      setShowErrors(true);
      return;
    }
    if (editingKey && !newKey.trim() && !view.hasApiKey) {
      setTest({ running: false, needKey: true });
      return;
    }
    setTest({ running: true });
    try {
      const result = await window.alia.request('settings.testConnection', { endpointUrl: draft.endpointUrl.trim(), ...(keyPending ? { apiKey: newKey.trim() } : {}) });
      setTest({ running: false, result });
    } catch (e) {
      setTest({ running: false, result: { ok: false, models: [], reason: 'other', message: message(e) } });
    }
  };

  const importConfig = async () => {
    setStatus(undefined);
    try {
      const summary = await window.alia.request('settings.importLegacy', {});
      if (!summary) return;
      await load();
      onSaved(await window.alia.request('settings.get', {}));
      setStatus({ kind: 'ok', text: t.settings.import.done(summary.models, summary.importedKey) + (summary.importedKey ? '' : ` ${t.settings.import.noKey}`) });
    } catch (e) {
      setStatus({ kind: 'error', text: t.settings.import.failed(message(e)) });
    }
  };

  const removeKey = async () => {
    const next = await window.alia.request('settings.clearApiKey', {});
    setView(next);
    setEditingKey(true);
    setNewKey('');
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

  const configuredIds = new Set(draft.models.map((m) => m.id));

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

      {legacy && (
        <div className="banner" role="note" data-testid="legacy-banner">
          <p>{t.settings.import.found(legacy.path, legacy.models)}</p>
          <button type="button" className="btn primary" onClick={importConfig}>{t.settings.import.button}</button>
        </div>
      )}

      <div className="card">
        <h2>{t.settings.connection.title}</h2>
        <label className="field">
          <span>{t.settings.connection.endpoint}</span>
          <input type="url" value={draft.endpointUrl} onChange={(e) => set({ endpointUrl: e.target.value })} aria-invalid={!!err('endpoint')} aria-describedby="endpoint-hint endpoint-error" spellCheck={false} />
        </label>
        <p className="hint" id="endpoint-hint">{t.settings.connection.endpointHint}</p>
        {err('endpoint') && <p className="error" id="endpoint-error" role="alert">{err('endpoint')}</p>}

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
              <input type="password" aria-labelledby="key-label" value={newKey} onChange={(e) => setNewKey(e.target.value)} placeholder={t.settings.connection.keyPlaceholder} autoComplete="off" spellCheck={false} disabled={!view.secureStorage} aria-invalid={!!err('key')} />
              {view.hasApiKey && <button type="button" className="btn" onClick={() => { setEditingKey(false); setNewKey(''); }}>{t.settings.connection.keyCancel}</button>}
            </div>
          )}
          <p className="hint">{t.settings.connection.keyNote}</p>
          {err('key') && <p className="error" role="alert">{err('key')}</p>}
        </div>

        <div className="row">
          <button type="button" className="btn" onClick={runTest} disabled={test.running}>{test.running ? t.settings.connection.testing : t.settings.connection.test}</button>
          {test.needKey && <span className="error">{t.settings.connection.needKey}</span>}
        </div>
        {test.result && (
          <div className={`result ${test.result.ok ? 'ok' : 'bad'}`} role="status" data-testid="test-result">
            {test.result.ok ? t.settings.connection.ok(test.result.models.length) : t.settings.connection.reasons[test.result.reason ?? 'other']}
            {test.result.ok && test.result.models.length > 0 && (
              <ul className="remote-models" aria-label={t.settings.connection.available}>
                {test.result.models.map((id) => (
                  <li key={id}>
                    <code>{id}</code>
                    {configuredIds.has(id) ? (
                      <span className="hint">{t.settings.connection.alreadyAdded}</span>
                    ) : (
                      <button type="button" className="btn small" onClick={() => set({ models: [...draft.models, { id, name: id }] })}>{t.settings.connection.addModel}</button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="card">
        <h2>{t.settings.models.title}</h2>
        <p className="hint">{t.settings.models.hint}</p>
        {err('models') && <p className="error" role="alert">{err('models')}</p>}
        <table className="models">
          <thead>
            <tr><th scope="col">{t.settings.models.id}</th><th scope="col">{t.settings.models.name}</th><th scope="col">{t.settings.models.context}</th><th scope="col"><span className="sr-only">{t.settings.models.remove('')}</span></th></tr>
          </thead>
          <tbody>
            {draft.models.map((m, i) => (
              <tr key={i}>
                <td>
                  <input aria-label={`${t.settings.models.id} ${i + 1}`} value={m.id} onChange={(e) => setModel(i, { id: e.target.value })} aria-invalid={!!err(`model-${i}-id`)} spellCheck={false} />
                  {err(`model-${i}-id`) && <p className="error" role="alert">{err(`model-${i}-id`)}</p>}
                </td>
                <td><input aria-label={`${t.settings.models.name} ${i + 1}`} value={m.name} onChange={(e) => setModel(i, { name: e.target.value })} /></td>
                <td>
                  <input aria-label={`${t.settings.models.context} ${i + 1}`} inputMode="numeric" value={m.maxInputTokens ?? ''} onChange={(e) => setModel(i, { maxInputTokens: e.target.value === '' ? undefined : Number(e.target.value) })} aria-invalid={!!err(`model-${i}-context`)} />
                  {err(`model-${i}-context`) && <p className="error" role="alert">{err(`model-${i}-context`)}</p>}
                </td>
                <td><button type="button" className="btn small danger" aria-label={t.settings.models.remove(m.name || m.id)} onClick={() => set({ models: draft.models.filter((_, j) => j !== i) })}>×</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <button type="button" className="btn" onClick={() => set({ models: [...draft.models, { id: '', name: '', maxInputTokens: 128000 }] })}>{t.settings.models.add}</button>
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
        <button type="button" className="btn" onClick={importConfig}>{t.settings.import.fromFile}</button>
        {status && <span className={status.kind === 'ok' ? 'ok-text' : 'error'} role="status" data-testid="status">{status.text}</span>}
        {dirty && !status && <span className="hint">{t.settings.unsaved}</span>}
      </footer>
    </section>
  );
}
