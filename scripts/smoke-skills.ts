import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import {
  SkillRegistry,
  parseFrontmatter,
  bundledSkillsDir,
  buildSkillCatalog,
  buildSkillInvocationPrompt,
  formatSkillForModel,
} from '../src/skills/skillLoader.js';
import { createUseSkillTool } from '../src/tools/useSkill.js';
import { ToolRegistry } from '../src/tools/index.js';
import { ContextManager } from '../src/context/contextManager.js';
import { SafetyChecker } from '../src/safety/safetyChecker.js';
import { SLASH_COMMANDS, registerSkillCommands } from '../src/ui/prompt.js';

let failures = 0;
function check(name: string, cond: boolean, extra = '') {
  if (cond) console.log(`  ✔ ${name}`);
  else {
    failures++;
    console.log(`  ✘ ${name} ${extra}`);
  }
}

console.log('\n=== frontmatter ===');
const fm = parseFrontmatter(
  '---\nname: demo\ndescription: >\n  Folded line one\n  line two.\nrequires: a, b\nquoted: "x: y"\n---\n# Body\n'
);
check('folded scalar joined', fm.data.description === 'Folded line one line two.', JSON.stringify(fm.data));
check('plain list value kept', fm.data.requires === 'a, b');
check('quoted value unquoted', fm.data.quoted === 'x: y');
check('body split off', fm.body.trim() === '# Body');
check('no frontmatter -> body only', parseFrontmatter('# hi').body === '# hi');

console.log('\n=== bundled skills ===');
const tools = new ToolRegistry();
const registry = new SkillRegistry({
  roots: [{ label: 'bundled', dir: bundledSkillsDir() }],
  getToolNames: () => tools.getAll().map((t) => t.name),
});
registry.load();
tools.register(createUseSkillTool(registry));
const names = registry.all().map((s) => s.name);
console.log(`  found ${names.length}: ${names.join(', ')}`);
check('loads the hub skills', names.length >= 19);
check('uses frontmatter name for e2e-pipeline', names.includes('requirements-to-tasks-pipeline'));
check('promoted skills are top-level', ['requirement-extraction-from-threads', 'ddd-bounded-context', 'ddd-context-map'].every((n) => names.includes(n)));
check('no nested duplicates (no recursion)', new Set(names).size === names.length && !fs.existsSync(path.join(bundledSkillsDir(), 'e2e-pipeline', 'skills')));
check('every skill has a description', registry.all().every((s) => s.description.length > 20));
check('folded descriptions parsed (constitution-to-specs)', (registry.get('constitution-to-specs')?.description ?? '').startsWith('Reads a new software project'));

console.log('\n=== requires gating ===');
const jira = registry.get('add-tasks-to-jira')!;
const pw = registry.get('playwright-mcp-verification')!;
check('jira skill gated without MCP', !registry.isAvailable(jira));
check('playwright-mcp skill gated without MCP', !registry.isAvailable(pw));
check('plain skills available', registry.isAvailable(registry.get('spec-to-tasks')!));
const withMcp = new SkillRegistry({
  roots: [{ label: 'bundled', dir: bundledSkillsDir() }],
  getToolNames: () => ['mcp__atlassian__createJiraIssue', 'mcp__atlassian__searchJiraIssuesUsingJql'],
});
withMcp.load();
check('MCP-prefixed tool names satisfy requires', withMcp.isAvailable(withMcp.get('add-tasks-to-jira')!));

console.log('\n=== catalog ===');
const catalog = buildSkillCatalog(registry);
console.log(`  catalog: ${catalog.length} chars (~${Math.ceil(catalog.length / 4)} tokens)`);
check('catalog lists available skills', catalog.includes('- spec-to-tasks:'));
check('catalog hides gated skills', !catalog.includes('- add-tasks-to-jira:') && !catalog.includes('- playwright-mcp-verification:'));
check('catalog stays small', catalog.length < 12000);

console.log('\n=== use_skill + path rewrite ===');
const ctx = {
  workingDirectory: process.cwd(),
  safetyChecker: new SafetyChecker(true),
  contextManager: new ContextManager(),
};
const out = await tools.execute('use_skill', JSON.stringify({ name: 'embrapii-docs' }), ctx);
check('returns pinned <skill> block', out.startsWith('<skill name="embrapii-docs"'));
check('not truncated (>16k chars)', out.length > 16000 && !out.includes('Truncated'), `len=${out.length}`);
check('.claude/skills paths rewritten to real dir', !out.includes('.claude/skills/embrapii-docs') && out.includes('/skills/embrapii-docs/scripts/check_doc.py'));
check('rewritten script path exists', fs.existsSync(path.join(bundledSkillsDir(), 'embrapii-docs', 'scripts', 'check_doc.py')));
check('harness notes included', out.includes('use_skill') && out.includes('AskUserQuestion'));
check('unknown skill -> Error + list', (await tools.execute('use_skill', '{"name":"nope"}', ctx)).startsWith('Error: Unknown skill'));
check('gated skill -> Error', (await tools.execute('use_skill', '{"name":"add-tasks-to-jira"}', ctx)).includes('unavailable'));
check('accepts leading slash', (await tools.execute('use_skill', '{"name":"/adr-reader"}', ctx)).startsWith('<skill name="adr-reader"'));

console.log('\n=== invocation prompt ===');
const inv = buildSkillInvocationPrompt(registry.get('ticket-to-brief')!, registry, 'fix the login bug');
check('mentions already loaded', inv.includes('do not call use_skill'));
check('carries the user input', inv.endsWith('Request / input: fix the login bug'));
check('empty input handled', buildSkillInvocationPrompt(registry.get('ticket-to-brief')!, registry, '  ').includes('none given'));
check('format helper starts with tag', formatSkillForModel(registry.get('adr-reader')!, registry).startsWith('<skill '));

console.log('\n=== pruning keeps skills ===');
const cm = new ContextManager({ maxInputTokens: 2000, pruneThresholdRatio: 0.1 });
const big = 'x'.repeat(1200);
const msgs: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
  { role: 'system', content: 'sys' },
  { role: 'tool', tool_call_id: 'a', content: out },
  { role: 'tool', tool_call_id: 'b', content: big },
  ...Array.from({ length: 14 }, (_, i): OpenAI.Chat.Completions.ChatCompletionMessageParam => ({
    role: 'user',
    content: `turn ${i}`,
  })),
];
const pr = cm.pruneMessages(msgs);
check('pruning happened', pr.pruned);
check('ordinary old tool output archived', (pr.messages[2].content as string).startsWith('[Previous tool output archived'));
check('skill output NOT archived', pr.messages[1].content === out);

console.log('\n=== root precedence & slash commands ===');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alia-skills-'));
try {
  const mk = (root: string, dir: string, body: string) => {
    fs.mkdirSync(path.join(tmp, root, dir), { recursive: true });
    fs.writeFileSync(path.join(tmp, root, dir, 'SKILL.md'), body);
  };
  mk('a', 'dup', '---\nname: dup\ndescription: from a\n---\nA');
  mk('b', 'dup', '---\nname: dup\ndescription: from b\n---\nB');
  mk('b', 'nodesc', '---\nname: nodesc\n---\nbody');
  const over = new SkillRegistry({
    roots: [
      { label: 'low', dir: path.join(tmp, 'a') },
      { label: 'high', dir: path.join(tmp, 'b') },
    ],
  });
  over.load();
  check('later root overrides earlier', over.get('dup')?.description === 'from b' && over.get('dup')?.source === 'high');
  check('missing description warns', over.warnings.some((w) => w.includes('nodesc')));
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

const skipped = registerSkillCommands([...registry.available(), { name: 'help', description: 'clash' }]);
check('skill commands registered', SLASH_COMMANDS.some((c) => c.command === '/spec-to-tasks' && c.skill && c.acceptsArgs));
check('built-in clash skipped', skipped.includes('help') && SLASH_COMMANDS.filter((c) => c.command === '/help').length === 1);
registerSkillCommands([]);
check('re-registering replaces skill commands', !SLASH_COMMANDS.some((c) => c.skill));

console.log(failures === 0 ? '\nAll skill checks passed.' : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
