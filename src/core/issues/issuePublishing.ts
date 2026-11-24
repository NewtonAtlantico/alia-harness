import { execFile } from 'node:child_process';

/**
 * Can "Publicar issues" really publish, or must it fall back to drafts in `docs/issues/`?
 *
 * A tracker connection exists when either:
 *   - an MCP-backed issue tool is registered (the future MCP client names them `mcp__<server>__<tool>`,
 *     the same naming the skills' `requires:` rule already matches), or
 *   - the `gh` / `glab` CLI is installed and signed in for the host of this repository's `origin` remote
 *     (the `issue-writer` skill already prefers the CLI).
 * Otherwise the answer is `drafts`, with a warning to show **every time** the user tries to publish.
 */

export const DRAFTS_DIR = 'docs/issues';

export type CliState = 'ready' | 'unauthenticated' | 'missing';
export type GitProvider = 'github' | 'gitlab' | 'other';

export interface IssuePublishingStatus {
  /** Registered tools that can create an issue (e.g. `mcp__github__create_issue`, `createJiraIssue`). */
  mcp: string[];
  /** State of each CLI for this repository's remote host (only those that apply are listed). */
  cli: { gh?: CliState; glab?: CliState };
  /** The repository's `origin` remote, when it has one. */
  remote?: { host: string; provider: GitProvider };
  mode: 'publish' | 'drafts';
  /** How it would publish, when it can. A ready CLI is preferred, as the skill does. */
  via?: 'gh' | 'glab' | 'mcp';
  /** The skill to run: `add-tasks-to-jira` when its Jira tools are present, otherwise `issue-writer`. */
  skill: 'add-tasks-to-jira' | 'issue-writer';
  /** Shown before publishing when `mode` is `drafts`: why, how to fix it, and where the drafts go. */
  warning?: string;
  draftsDir: string;
}

export interface ProbeResult {
  /** Exit code, or null if it did not finish. */
  code: number | null;
  stdout: string;
  /** The program is not installed. */
  missing: boolean;
  timedOut: boolean;
}

/** Runs a program and reports what happened. Injected so tests need no real CLI. */
export type CommandProbe = (command: string, args: string[], cwd: string) => Promise<ProbeResult>;

/** The real probe: runs the program with a short timeout and never throws. */
export function createExecProbe(timeoutMs = 5000): CommandProbe {
  return (command, args, cwd) =>
    new Promise<ProbeResult>((resolve) => {
      try {
        const child = execFile(command, args, { cwd, timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
          if (!error) return resolve({ code: 0, stdout: String(stdout ?? ''), missing: false, timedOut: false });
          const e = error as NodeJS.ErrnoException & { killed?: boolean; code?: any };
          if (e.code === 'ENOENT') return resolve({ code: null, stdout: '', missing: true, timedOut: false });
          resolve({ code: typeof e.code === 'number' ? e.code : null, stdout: String(stdout ?? ''), missing: false, timedOut: e.killed === true });
        });
        child.on('error', () => {});
      } catch {
        resolve({ code: null, stdout: '', missing: true, timedOut: false });
      }
    });
}

/** Tool names that create an issue. Matched on the last segment, so `mcp__github__create_issue` and `createJiraIssue` both count. */
export function isIssueCreationTool(name: string): boolean {
  const base = name.split('__').pop() ?? name;
  return /^(jira|github|gitlab|linear)?(create|save)(jira|github|gitlab|linear)?(issue|ticket)$/.test(base.replace(/[_-]/g, '').toLowerCase());
}

/** `https://github.com/o/r.git`, `git@github.com:o/r.git`, `ssh://git@gitlab.corp:2222/o/r` -> the host. */
export function parseRemoteHost(url: string): string | undefined {
  const u = url.trim();
  const scp = /^[\w.-]+@([^:/\s]+):/.exec(u); // git@host:org/repo
  if (scp) return scp[1].toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^:/\s]+)/i.exec(u);
  return scheme ? scheme[1].toLowerCase() : undefined;
}

export function providerOf(host: string): GitProvider {
  if (host.includes('github')) return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  return 'other';
}

async function cliState(probe: CommandProbe, cli: 'gh' | 'glab', host: string, cwd: string): Promise<CliState> {
  const r = await probe(cli, ['auth', 'status', '--hostname', host], cwd);
  if (r.missing) return 'missing';
  return r.code === 0 ? 'ready' : 'unauthenticated';
}

export interface IssuePublishingInput {
  workspace: string;
  /** Every tool registered in the session. */
  toolNames: string[];
}

export async function detectIssuePublishing(input: IssuePublishingInput, options: { probe?: CommandProbe } = {}): Promise<IssuePublishingStatus> {
  const probe = options.probe ?? createExecProbe();
  const mcp = input.toolNames.filter(isIssueCreationTool);
  const jira = input.toolNames.some((n) => n.split('__').pop() === 'createJiraIssue') && input.toolNames.some((n) => n.split('__').pop() === 'searchJiraIssuesUsingJql');
  const skill: IssuePublishingStatus['skill'] = jira ? 'add-tasks-to-jira' : 'issue-writer';

  // Which host does this repository publish to?
  let remote: IssuePublishingStatus['remote'];
  const url = await probe('git', ['remote', 'get-url', 'origin'], input.workspace);
  if (!url.missing && url.code === 0) {
    const host = parseRemoteHost(url.stdout);
    if (host) remote = { host, provider: providerOf(host) };
  }

  // Only the CLI that serves that host matters. An unknown host (a self-hosted server) is tried with both.
  const cli: IssuePublishingStatus['cli'] = {};
  if (remote) {
    if (remote.provider !== 'gitlab') cli.gh = await cliState(probe, 'gh', remote.host, input.workspace);
    if (remote.provider !== 'github') cli.glab = await cliState(probe, 'glab', remote.host, input.workspace);
  }

  const via: IssuePublishingStatus['via'] = cli.gh === 'ready' ? 'gh' : cli.glab === 'ready' ? 'glab' : mcp.length > 0 ? 'mcp' : undefined;
  if (via) return { mcp, cli, ...(remote ? { remote } : {}), mode: 'publish', via, skill, draftsDir: DRAFTS_DIR };

  return { mcp, cli, ...(remote ? { remote } : {}), mode: 'drafts', skill: 'issue-writer', warning: draftsWarning(remote, cli), draftsDir: DRAFTS_DIR };
}

/** The "no tracker connection" warning: why, what to do about it, and where the drafts will go. */
function draftsWarning(remote: IssuePublishingStatus['remote'], cli: IssuePublishingStatus['cli']): string {
  const why: string[] = ['no issue tool is available'];
  const fixes: string[] = [];
  if (!remote) {
    why.push('this folder has no git remote to publish to');
  } else {
    for (const [name, state] of Object.entries(cli) as Array<['gh' | 'glab', CliState]>) {
      const product = name === 'gh' ? 'the GitHub CLI (gh)' : 'the GitLab CLI (glab)';
      if (state === 'missing') {
        why.push(`${product} is not installed`);
        fixes.push(`install ${product}`);
      } else if (state === 'unauthenticated') {
        why.push(`${product} is not signed in to ${remote.host}`);
        fixes.push(`run \`${name} auth login --hostname ${remote.host}\``);
      }
    }
  }
  return [
    `No issue tracker connection was found (${why.join('; ')}).`,
    `The issues will be saved as drafts in ${DRAFTS_DIR}/ for you to publish by hand.`,
    fixes.length > 0 ? `To publish them directly: ${fixes.join(' or ')}, then try again.` : '',
  ]
    .filter(Boolean)
    .join(' ');
}
