/**
 * The Jira connection as the page handles it: the form of "Outro servidor MCP" turned into what the app is asked to connect, the
 * checks on that form, the sentences for each way a connection fails, and which saved server is the Jira one. No React, no DOM.
 */
import type { JiraTarget, McpAuthKind, McpFailure, McpProject, McpProjectList, McpServerInput, McpServerSummary, McpTestResult, McpView } from '../../../shared/ipc';
import { t } from '../i18n/pt-BR';

/** What "Entrar com a Atlassian" connects to. */
export const ATLASSIAN_URL = 'https://mcp.atlassian.com/v1/mcp';

export interface EnvRow {
  name: string;
  value: string;
  secret: boolean;
}

/** The fields of "Outro servidor MCP". `args` is one line of text, split the way a shell would. */
export interface OtherForm {
  kind: 'http' | 'stdio';
  url: string;
  auth: McpAuthKind;
  token: string;
  command: string;
  args: string;
  env: EnvRow[];
}

export const emptyForm = (): OtherForm => ({ kind: 'http', url: '', auth: 'oauth', token: '', command: '', args: '', env: [] });

/** The input for the Atlassian preset: no label, the app names it. */
export const atlassianInput = (): McpServerInput => ({ preset: 'atlassian', transport: { type: 'http', url: ATLASSIAN_URL }, auth: 'oauth' });

/**
 * Splits a line of arguments the way a shell does: by spaces, with "double quotes" keeping the spaces inside them (and `\"` for a
 * quote inside quotes). A backslash anywhere else stays as written, so a Windows path survives. `""` is an empty argument.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '\\' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (c === '"') quoted = false;
      else current += c;
    } else if (c === '"') {
      quoted = true;
      started = true;
    } else if (/\s/.test(c)) {
      if (started) out.push(current);
      current = '';
      started = false;
    } else {
      current += c;
      started = true;
    }
  }
  if (started) out.push(current);
  return out;
}

/** Whether a double quote in `text` is never closed. */
export function hasOpenQuote(text: string): boolean {
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (quoted && text[i] === '\\' && text[i + 1] === '"') i++;
    else if (text[i] === '"') quoted = !quoted;
  }
  return quoted;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A problem with an address: null when it is fine. https:// anywhere, http:// only for this computer. */
export function urlProblem(raw: string): string | null {
  const text = raw.trim();
  if (!text) return t.jira.errors.urlEmpty;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return t.jira.errors.urlInvalid;
  }
  if (url.protocol === 'https:') return url.hostname ? null : t.jira.errors.urlInvalid;
  if (url.protocol === 'http:') return LOCAL_HOSTS.has(url.hostname) ? null : t.jira.errors.urlInsecure;
  return t.jira.errors.urlInvalid;
}

/** An environment row that has no name and no value is a blank line, not a mistake. */
const isBlankRow = (r: EnvRow) => r.name.trim() === '' && r.value === '';

export interface FormErrors {
  url?: string;
  token?: string;
  command?: string;
  args?: string;
  /** By row, the position in `form.env`. */
  env: Record<number, string>;
}

/** What is wrong with the form (what the active transport needs; the other one's fields are ignored). */
export function validateForm(form: OtherForm): { ok: boolean; errors: FormErrors } {
  const errors: FormErrors = { env: {} };
  if (form.kind === 'http') {
    const url = urlProblem(form.url);
    if (url) errors.url = url;
    if (form.auth === 'token' && form.token.trim() === '') errors.token = t.jira.errors.tokenEmpty;
  } else {
    if (form.command.trim() === '') errors.command = t.jira.errors.commandEmpty;
    if (hasOpenQuote(form.args)) errors.args = t.jira.errors.quote;
    const seen = new Set<string>();
    form.env.forEach((row, i) => {
      if (isBlankRow(row)) return;
      const name = row.name.trim();
      if (name === '') errors.env[i] = t.jira.errors.envNameEmpty;
      else if (!ENV_NAME.test(name)) errors.env[i] = t.jira.errors.envName;
      else if (seen.has(name)) errors.env[i] = t.jira.errors.envDuplicate;
      seen.add(name);
    });
  }
  const ok = !errors.url && !errors.token && !errors.command && !errors.args && Object.keys(errors.env).length === 0;
  return { ok, errors };
}

/** The input to ask the app to test, sign in or save, from the form. Call it only when `validateForm` says ok. */
export function buildServerInput(form: OtherForm): McpServerInput {
  if (form.kind === 'http') {
    return {
      preset: 'custom',
      transport: { type: 'http', url: form.url.trim() },
      auth: form.auth,
      ...(form.auth === 'token' ? { token: form.token.trim() } : {}),
    };
  }
  return {
    preset: 'custom',
    transport: {
      type: 'stdio',
      command: form.command.trim(),
      args: splitArgs(form.args),
      env: form.env.filter((r) => !isBlankRow(r)).map((r) => ({ name: r.name.trim(), ...(r.value !== '' ? { value: r.value } : {}), secret: r.secret })),
    },
    auth: 'none',
  };
}

/** Identifies what a test was run against: any edit to the form changes it, so the result no longer holds. */
export function formSignature(form: OtherForm): string {
  return JSON.stringify(buildServerInput(form));
}

/** Whether the form needs the OS to encrypt something: a token, a browser sign-in or a secret variable. */
export function needsSecureStorage(form: OtherForm): boolean {
  if (form.kind === 'http') return form.auth !== 'none';
  return form.env.some((r) => r.secret && !isBlankRow(r));
}

/** The sentence for a failed connection. `toolCount` is the server's own count, used when it has tools but none creates issues. */
export function failureText(reason: McpFailure | undefined, toolCount = 0): string {
  switch (reason) {
    case 'no_issue_tool':
      return t.jira.failure.no_issue_tool(toolCount);
    case 'unreachable':
    case 'unauthorized':
    case 'needs_sign_in':
    case 'timeout':
    case 'bad_config':
    case 'cancelled':
      return t.jira.failure[reason];
    default:
      return t.jira.failure.other;
  }
}

/** The sentence for a test or sign-in that did not pass. */
export function resultProblem(r: McpTestResult): string {
  return failureText(r.reason ?? 'other', r.toolCount);
}

/** The Jira server among the saved ones: the first that is connected and can create issues. */
export function pickJiraServer(view: McpView | undefined): McpServerSummary | undefined {
  return view?.servers.find((s) => s.connected && s.capabilities?.createsIssues === true);
}

/** Whether this project sends to Jira: its target names a server that is connected and can create issues. */
export function jiraServerFor(view: McpView | undefined, target: JiraTarget | null | undefined): McpServerSummary | undefined {
  if (!view || !target) return undefined;
  return view.servers.find((s) => s.id === target.serverId && s.connected && s.capabilities?.createsIssues === true);
}

/** The server a `mcp.save` just stored: the one that is new, the one asked for by id, or else the Jira one. */
export function savedServer(before: McpView | undefined, after: McpView, askedId?: string): McpServerSummary | undefined {
  if (askedId) return after.servers.find((s) => s.id === askedId);
  const known = new Set(before?.servers.map((s) => s.id));
  const fresh = after.servers.filter((s) => !known.has(s.id));
  if (fresh.length === 1) return fresh[0];
  return pickJiraServer(after) ?? after.servers.find((s) => s.id === 'jira');
}

/** A project key as Jira writes it. */
export const normalizeKey = (raw: string): string => raw.trim().toUpperCase();
export const isProjectKey = (raw: string): boolean => /^[A-Z][A-Z0-9_]*$/.test(normalizeKey(raw)) && normalizeKey(raw).length <= 100;

/** What the project step offers: a choice among the projects the server listed, or a text box for the key. */
export function projectMode(list: McpProjectList | undefined): 'select' | 'text' {
  return list && list.listed && list.projects.length > 0 ? 'select' : 'text';
}

/** The target to save. A key that is in the list brings its name and site; a typed key brings only the key. */
export function buildTarget(serverId: string, key: string, projects: McpProject[] = [], fallbackSite?: string): JiraTarget {
  const projectKey = normalizeKey(key);
  const found = projects.find((p) => normalizeKey(p.key) === projectKey);
  return {
    serverId,
    projectKey,
    ...(found?.name ? { projectName: found.name } : {}),
    ...((found?.site ?? fallbackSite) ? { site: found?.site ?? fallbackSite } : {}),
  };
}
