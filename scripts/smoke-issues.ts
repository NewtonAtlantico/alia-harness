import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AliaConfig } from '../src/core/config.js';
import { createSession } from '../src/core/session.js';
import { bundledSkillsDir } from '../src/core/skills/skillLoader.js';
import {
  CommandProbe,
  DRAFTS_DIR,
  ProbeResult,
  createExecProbe,
  detectIssuePublishing,
  isIssueCreationTool,
  parseRemoteHost,
  providerOf,
} from '../src/core/issues/issuePublishing.js';
import { FakeModel } from './lib/fakeModel.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-issues-'));
const BASE_TOOLS = ['read_file', 'write_file', 'edit_file', 'list_files', 'grep_search', 'run_bash', 'use_skill', 'run_subagent', 'pipeline_state'];

const ok = (stdout = ''): ProbeResult => ({ code: 0, stdout, missing: false, timedOut: false });
const failed: ProbeResult = { code: 1, stdout: '', missing: false, timedOut: false };
const absent: ProbeResult = { code: null, stdout: '', missing: true, timedOut: false };

/** A scripted probe: the remote URL and what each CLI says. Records every call. */
function probeOf(setup: { remote?: string | null; gh?: 'ready' | 'unauthenticated' | 'missing'; glab?: 'ready' | 'unauthenticated' | 'missing'; ghHosts?: string[] }) {
  const calls: string[] = [];
  const result = (s: 'ready' | 'unauthenticated' | 'missing' | undefined) => (s === 'ready' ? ok() : s === 'unauthenticated' ? failed : absent);
  const probe: CommandProbe = async (command, args) => {
    calls.push(`${command} ${args.join(' ')}`);
    if (command === 'git') return setup.remote ? ok(`${setup.remote}\n`) : failed;
    if (command === 'gh') {
      const host = args[args.indexOf('--hostname') + 1];
      return setup.ghHosts && !setup.ghHosts.includes(host) ? failed : result(setup.gh);
    }
    if (command === 'glab') return result(setup.glab);
    return absent;
  };
  return { probe, calls };
}
const detect = (toolNames: string[], setup: Parameters<typeof probeOf>[0]) => {
  const p = probeOf(setup);
  return detectIssuePublishing({ workspace: tmp, toolNames }, { probe: p.probe }).then((status) => ({ status, calls: p.calls }));
};

console.log('\n=== which tools create issues ===');
{
  const yes = ['mcp__github__create_issue', 'mcp__gitlab__create_issue', 'createJiraIssue', 'mcp__plugin_atlassian_atlassian__createJiraIssue', 'mcp__linear__save_issue', 'create_issue', 'mcp__x__createIssue', 'mcp__x__create-ticket'];
  const no = [...BASE_TOOLS, 'mcp__github__list_issues', 'mcp__github__search_issues', 'mcp__github__create_pull_request', 'mcp__github__update_issue', 'mcp__github__get_issue', 'searchJiraIssuesUsingJql', 'create_branch', 'ask_user', 'delete_issue', 'mcp__github__create_issue_comment'];
  for (const n of yes) check(`counts: ${n}`, isIssueCreationTool(n));
  for (const n of no) check(`does not count: ${n}`, !isIssueCreationTool(n));
}

console.log('\n=== remotes ===');
{
  check('https', parseRemoteHost('https://github.com/NewtonAtlantico/alia-harness.git') === 'github.com');
  check('https with credentials and a port', parseRemoteHost('https://user:tok@git.corp.example:8443/o/r.git') === 'git.corp.example');
  check('scp-style ssh', parseRemoteHost('git@gitlab.com:group/sub/repo.git') === 'gitlab.com');
  check('ssh:// with a port', parseRemoteHost('ssh://git@gitlab.empresa.com.br:2222/o/r') === 'gitlab.empresa.com.br');
  check('trailing newline and mixed case', parseRemoteHost('  HTTPS://GitHub.com/o/r\n') === 'github.com');
  check('garbage has no host', parseRemoteHost('not a url') === undefined && parseRemoteHost('') === undefined);
  check('providers', providerOf('github.com') === 'github' && providerOf('github.empresa.com') === 'github' && providerOf('gitlab.com') === 'gitlab' && providerOf('git.corp.example') === 'other');
}

console.log('\n=== nothing to publish with: drafts, and a warning that explains ===');
{
  const { status, calls } = await detect(BASE_TOOLS, { remote: 'https://github.com/o/r.git', gh: 'missing' });
  check('no tool and no CLI: drafts', status.mode === 'drafts' && status.via === undefined && status.skill === 'issue-writer' && status.draftsDir === DRAFTS_DIR);
  check('the warning says nothing was found, where the drafts go, and how to fix it', !!status.warning && status.warning.startsWith('No issue tracker connection was found') && status.warning.includes('docs/issues/') && status.warning.includes('install the GitHub CLI (gh)') && status.warning.includes('is not installed'), status.warning);
  check('it asked about the CLI of that host only', calls.join('|') === 'git remote get-url origin|gh auth status --hostname github.com', calls.join('|'));

  const unauth = (await detect(BASE_TOOLS, { remote: 'https://github.com/o/r.git', gh: 'unauthenticated' })).status;
  check('gh installed but not signed in: drafts, and the exact command to run', unauth.mode === 'drafts' && unauth.cli.gh === 'unauthenticated' && unauth.warning!.includes('not signed in to github.com') && unauth.warning!.includes('gh auth login --hostname github.com'), unauth.warning);

  const lab = (await detect(BASE_TOOLS, { remote: 'git@gitlab.com:g/r.git', glab: 'unauthenticated' })).status;
  check('the same for GitLab, with glab', lab.mode === 'drafts' && lab.warning!.includes('glab auth login --hostname gitlab.com') && lab.cli.gh === undefined && lab.cli.glab === 'unauthenticated');

  const noRemote = (await detect(BASE_TOOLS, { remote: null })).status;
  check('no git remote: nothing to publish to, and it says so', noRemote.mode === 'drafts' && noRemote.remote === undefined && noRemote.warning!.includes('no git remote') && Object.keys(noRemote.cli).length === 0);

  const other = (await detect(BASE_TOOLS, { remote: 'https://git.corp.example/o/r.git', gh: 'missing', glab: 'missing' })).status;
  check('an unknown (self-hosted) host: both CLIs are tried, and both are named', other.mode === 'drafts' && other.cli.gh === 'missing' && other.cli.glab === 'missing' && other.warning!.includes('GitHub CLI') && other.warning!.includes('GitLab CLI'));

  const again = (await detect(BASE_TOOLS, { remote: 'https://github.com/o/r.git', gh: 'missing' })).status;
  check('the warning is the same on every attempt (it is not "shown once")', again.warning === status.warning);
}

console.log('\n=== an MCP issue tool is enough ===');
{
  const gh = (await detect([...BASE_TOOLS, 'mcp__github__create_issue'], { remote: 'https://github.com/o/r.git', gh: 'missing' })).status;
  check('a GitHub MCP issue tool: publish via mcp, with no warning', gh.mode === 'publish' && gh.via === 'mcp' && gh.warning === undefined && gh.mcp.join() === 'mcp__github__create_issue' && gh.skill === 'issue-writer');
  const noRemote = (await detect([...BASE_TOOLS, 'mcp__github__create_issue'], { remote: null })).status;
  check('...even with no git remote (the tool knows where to publish)', noRemote.mode === 'publish' && noRemote.via === 'mcp');

  const jira = (await detect([...BASE_TOOLS, 'mcp__atlassian__createJiraIssue', 'mcp__atlassian__searchJiraIssuesUsingJql'], { remote: 'https://github.com/o/r.git', gh: 'missing' })).status;
  check('the Jira tools the skill needs: publish, with the Jira skill', jira.mode === 'publish' && jira.skill === 'add-tasks-to-jira' && jira.mcp.join() === 'mcp__atlassian__createJiraIssue');
  const half = (await detect([...BASE_TOOLS, 'mcp__atlassian__createJiraIssue'], { remote: null })).status;
  check('only half of them: it can still create issues, but the Jira skill would not be available, so issue-writer is named', half.mode === 'publish' && half.skill === 'issue-writer');
  const readOnly = (await detect([...BASE_TOOLS, 'mcp__github__list_issues', 'mcp__github__search_issues', 'mcp__github__create_pull_request'], { remote: 'https://github.com/o/r.git', gh: 'missing' })).status;
  check('read-only and unrelated tools do not count', readOnly.mode === 'drafts' && readOnly.mcp.length === 0);
}

console.log('\n=== a signed-in CLI is enough ===');
{
  const gh = await detect(BASE_TOOLS, { remote: 'https://github.com/o/r.git', gh: 'ready' });
  check('gh signed in for a GitHub remote: publish via gh', gh.status.mode === 'publish' && gh.status.via === 'gh' && gh.status.warning === undefined && gh.status.cli.gh === 'ready' && gh.status.skill === 'issue-writer');
  check('glab is not even asked about for a GitHub remote', !gh.calls.some((c) => c.startsWith('glab')));
  const lab = (await detect(BASE_TOOLS, { remote: 'https://gitlab.com/g/r.git', glab: 'ready' })).status;
  check('glab signed in for a GitLab remote: publish via glab', lab.mode === 'publish' && lab.via === 'glab');
  const wrong = (await detect(BASE_TOOLS, { remote: 'https://gitlab.com/g/r.git', gh: 'ready', glab: 'missing' })).status;
  check('gh signed in does not help a GitLab repository', wrong.mode === 'drafts' && wrong.cli.gh === undefined);
  const ent = await detect(BASE_TOOLS, { remote: 'git@github.empresa.com.br:o/r.git', gh: 'ready', ghHosts: ['github.empresa.com.br'] });
  check('GitHub Enterprise: the check is made for that host, and passes', ent.status.mode === 'publish' && ent.calls.includes('gh auth status --hostname github.empresa.com.br'));
  const entOther = (await detect(BASE_TOOLS, { remote: 'git@github.empresa.com.br:o/r.git', gh: 'ready', ghHosts: ['github.com'] })).status;
  check('...and signed in to github.com only is not enough for it', entOther.mode === 'drafts' && entOther.cli.gh === 'unauthenticated');
  const selfHosted = (await detect(BASE_TOOLS, { remote: 'https://git.corp.example/o/r.git', gh: 'missing', glab: 'ready' })).status;
  check('a self-hosted GitLab (unknown host) with glab signed in publishes via glab', selfHosted.mode === 'publish' && selfHosted.via === 'glab');
  const both = (await detect([...BASE_TOOLS, 'mcp__github__create_issue'], { remote: 'https://github.com/o/r.git', gh: 'ready' })).status;
  check('with a CLI and an MCP tool, the CLI is preferred (as issue-writer does) and the tool is still listed', both.mode === 'publish' && both.via === 'gh' && both.mcp.length === 1);
}

console.log('\n=== the real probe ===');
{
  const probe = createExecProbe(300);
  const ver = await probe('node', ['-e', 'console.log("hello")'], tmp);
  check('runs a program and reports its output and exit code', ver.code === 0 && ver.stdout.trim() === 'hello' && !ver.missing && !ver.timedOut);
  const bad = await probe('node', ['-e', 'process.exit(3)'], tmp);
  check('a non-zero exit is reported, not thrown', bad.code === 3 && !bad.missing);
  const missing = await probe('definitely-not-a-real-program-xyz', [], tmp);
  check('a program that is not installed is "missing"', missing.missing === true && missing.code === null);
  const t0 = Date.now();
  const slow = await probe('node', ['-e', 'setTimeout(() => {}, 60000)'], tmp);
  check('a program that hangs is cut off, quickly, and reported as timed out', slow.timedOut === true && slow.code !== 0 && Date.now() - t0 < 5000, `${Date.now() - t0}ms`);

  // End to end with the real git and the real (here: absent) CLIs, in a folder with no remote.
  const ws = path.join(tmp, 'plain');
  fs.mkdirSync(ws);
  const real = await detectIssuePublishing({ workspace: ws, toolNames: BASE_TOOLS });
  check('with the real probe, in a folder with no git remote, it does not throw and falls back to drafts', real.mode === 'drafts' && !!real.warning && real.draftsDir === DRAFTS_DIR);
}

console.log('\n=== through a session ===');
{
  const config: AliaConfig = { name: 't', vendor: 't', apiKey: 'k', apiType: 'chat-completions', models: [{ id: 'fake-model', name: 'fake', url: 'http://fake', toolCalling: true }] };
  const session = createSession({ workspace: tmp, config, client: new FakeModel([]).client, skillRoots: [{ label: 'bundled', dir: bundledSkillsDir() }], permissionsDir: path.join(tmp, 'perm') });
  const p = probeOf({ remote: 'https://github.com/o/r.git', gh: 'missing' });

  const before = await session.issuePublishing({ probe: p.probe });
  check('a session with no issue tools falls back to drafts', before.mode === 'drafts' && before.skill === 'issue-writer' && !!before.warning);
  check('...and the Jira skill is indeed unavailable in that session', session.skills.isAvailable(session.skills.get('add-tasks-to-jira')!) === false);

  const tool = (name: string) => ({ name, description: 'x', parameters: { type: 'object' as const, properties: {} }, execute: async () => 'ok' });
  session.tools.register(tool('mcp__atlassian__createJiraIssue'));
  session.tools.register(tool('mcp__atlassian__searchJiraIssuesUsingJql'));
  const after = await session.issuePublishing({ probe: p.probe });
  check('once the Jira tools are registered it can publish, through the Jira skill', after.mode === 'publish' && after.via === 'mcp' && after.skill === 'add-tasks-to-jira' && after.warning === undefined);
  check('...and that skill is, consistently, available in the session (same rule as `requires:`)', session.skills.isAvailable(session.skills.get('add-tasks-to-jira')!) === true);
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exit(1);
}
console.log('\nAll issue publishing checks passed.');
