/**
 * Runtime checks for everything the renderer can send. Main runs these before forwarding anything;
 * every object is strict, so a field nobody declared is an error, not something quietly passed along.
 * The `satisfies` below makes the compiler check each schema against its type in `ipc.ts`.
 */
import { z } from 'zod';
import type { RendererRequestName, RendererRequests } from './ipc';

const sessionId = z.string().min(1).max(100).regex(/^[\w.-]+$/, 'not a valid id');
const conversationId = z.string().min(1).max(100).regex(/^[\w.-]+$/, 'not a valid id');
const projectPath = z.string().min(1).max(1024);
const relPath = z.string().min(1).max(1024);
const flowId = z.string().min(1).max(100).regex(/^[\w.-]+$/, 'not a valid flow id');
const limit = z.number().int().min(1).max(500);
const paths = z.array(relPath).max(1000);

export const MAX_PROMPT_CHARS = 200_000;

const strict = <T extends z.ZodRawShape>(shape: T) => z.strictObject(shape);

const userAnswer = strict({
  id: z.string().min(1).max(200),
  answer: z.union([z.string().max(20_000), z.boolean()]).optional(),
  deferred: z.boolean().optional(),
  owner: z.string().max(200).optional(),
});

const interactionResponse = z.union([
  strict({ decision: z.enum(['allow_once', 'allow_always', 'deny']) }),
  strict({ answers: z.array(userAnswer).max(50) }),
]);

const none = strict({});

const mcpId = z.string().min(1).max(40).regex(/^[A-Za-z0-9-]+$/, 'not a valid server id');
const mcpServerInput = strict({
  id: mcpId.optional(),
  preset: z.enum(['atlassian', 'custom']),
  label: z.string().trim().min(1).max(100).optional(),
  transport: z.union([
    strict({ type: z.literal('http'), url: z.string().trim().min(1).max(2048) }),
    strict({
      type: z.literal('stdio'),
      command: z.string().trim().min(1).max(1024),
      args: z.array(z.string().max(2048)).max(50),
      env: z.array(strict({ name: z.string().trim().min(1).max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'not a valid variable name'), value: z.string().max(8192).optional(), secret: z.boolean() })).max(50),
    }),
  ]),
  auth: z.enum(['oauth', 'token', 'none']),
  token: z.string().trim().min(1).max(8192).optional(),
});
const jiraTarget = strict({ serverId: mcpId, projectKey: z.string().trim().min(1).max(100), projectName: z.string().trim().max(200).optional(), site: z.string().trim().max(500).optional() });

const modelSetting = strict({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(200),
  maxInputTokens: z.number().int().min(1000).max(4_000_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(4_000_000).optional(),
  toolCalling: z.boolean().optional(),
  vision: z.boolean().optional(),
});

/** One schema per renderer request. */
export const rendererSchemas = {
  'session.open': strict({ projectPath, resumeId: conversationId.optional() }),
  'session.close': strict({ sessionId }),
  'session.run': strict({ sessionId, text: z.string().min(1).max(MAX_PROMPT_CHARS) }),
  'session.cancel': strict({ sessionId }),
  'session.compact': strict({ sessionId }),
  'session.reset': strict({ sessionId }),
  'session.usage': strict({ sessionId }),
  'model.list': strict({ sessionId }),
  'model.switch': strict({ sessionId, model: z.string().min(1).max(200) }),
  'commands.list': strict({ sessionId }),
  'files.search': strict({ sessionId, query: z.string().max(500), limit: limit.optional() }),
  'files.children': strict({ sessionId, dir: z.string().max(1024).optional() }),
  'files.preview': strict({ sessionId, path: relPath }),
  'changes.list': strict({ sessionId }),
  'changes.diff': strict({ sessionId, path: relPath }),
  'changes.revert': strict({ sessionId, paths: paths.optional() }),
  'changes.keep': strict({ sessionId, paths: paths.optional() }),
  'permissions.list': strict({ sessionId }),
  'permissions.remove': strict({ sessionId, command: z.string().min(1).max(4000), match: z.enum(['exact', 'prefix']).optional() }),
  'conversations.list': strict({ projectPath: projectPath.optional(), limit: limit.optional() }),
  'conversations.search': strict({ text: z.string().min(1).max(500), projectPath: projectPath.optional(), limit: limit.optional() }),
  'conversations.rename': strict({ id: conversationId, title: z.string().min(1).max(200) }),
  'conversations.delete': strict({ id: conversationId }),
  'conversations.load': strict({ id: conversationId }),
  'interaction.respond': strict({ id: z.string().min(1).max(100), response: interactionResponse }),
  'interaction.pending': none,
  'permissions.listForProject': strict({ projectPath }),
  'permissions.removeForProject': strict({ projectPath, command: z.string().min(1).max(4000), match: z.enum(['exact', 'prefix']).optional() }),
  'projects.pick': none,
  'attachments.pick': none,
  'projects.recent': none,
  'projects.inspect': strict({ projectPath }),
  'projects.setTrust': strict({ projectPath, trusted: z.boolean() }),
  'sessions.active': none,
  'pipeline.brief': strict({ projectPath }),
  'pipeline.status': strict({ projectPath }),
  'pipeline.flows': none,
  'pipeline.inspect': strict({ projectPath: projectPath.optional(), paths: z.array(relPath).min(1).max(100), flow: flowId.optional() }),
  'pipeline.start': strict({ sessionId, inputs: z.array(strict({ path: relPath, transcriptPath: relPath.optional() })).min(1).max(100), flow: flowId.optional(), projectName: z.string().trim().min(1).max(200).optional() }),
  'projectMeta.get': strict({ projectPath }),
  'projectMeta.set': strict({
    projectPath,
    patch: strict({
      name: z.string().trim().min(1).max(200).optional(),
      request: z.string().trim().max(20_000).optional(),
      owner: z.string().trim().max(200).optional(),
      handedOff: z.union([strict({ at: z.string().min(1).max(40), mode: z.enum(['publish', 'drafts']) }), z.null()]).optional(),
    }),
  }),
  'projects.create': strict({ name: z.string().trim().min(1).max(100), request: z.string().trim().max(20_000).optional() }),
  'summary.export': strict({ projectPath, kind: z.enum(['pdf', 'link']), title: z.string().trim().min(1).max(200), html: z.string().min(1).max(2_000_000), markdown: z.string().min(1).max(500_000) }),
  'pipeline.resume': strict({ sessionId }),
  'pipeline.state': strict({ projectPath }),
  'pipeline.answer': strict({ sessionId, gate: z.enum(['G1', 'G2', 'G3']), answers: z.array(userAnswer).min(1).max(50), by: z.string().trim().min(1).max(200) }),
  'pipeline.reviewSpec': strict({ sessionId, spec: z.string().min(1).max(200).regex(/^[\w.-]+$/, 'not a valid spec name'), status: z.enum(['reviewed', 'in_review', 'draft']), comment: z.string().trim().max(5000).optional(), by: z.string().trim().min(1).max(200) }),
  'pipeline.requestChanges': strict({ sessionId, spec: z.string().min(1).max(200).regex(/^[\w.-]+$/, 'not a valid spec name'), comment: z.string().trim().min(1).max(5000), by: z.string().trim().min(1).max(200) }),
  'issues.publish': strict({ sessionId, confirmDrafts: z.boolean().optional(), destination: z.literal('jira').optional() }),
  'mcp.get': none,
  'mcp.test': strict({ server: mcpServerInput }),
  'mcp.signIn': strict({ server: mcpServerInput }),
  'mcp.save': strict({ server: mcpServerInput }),
  'mcp.remove': strict({ id: mcpId }),
  'mcp.projects': strict({ serverId: mcpId }),
  'jira.getTarget': strict({ projectPath }),
  'jira.setTarget': strict({ projectPath, target: z.union([jiraTarget, z.null()]) }),
  'pipeline.approveGate': strict({ sessionId, gate: z.enum(['G1', 'G2', 'G3']) }),
  'settings.get': none,
  'settings.update': strict({
    displayName: z.string().trim().max(100).optional(),
    organization: z.string().trim().max(100).optional(),
    models: z.array(modelSetting).min(1, 'at least one model is needed').max(50).optional(),
    permissionMode: z.enum(['ask-dangerous', 'ask-commands', 'auto']).optional(),
  }),
  'settings.setApiKey': strict({ apiKey: z.string().trim().min(8, 'that looks too short to be an API key').max(4096) }),
  'settings.clearApiKey': none,
  'settings.refreshModels': none,
  'window.minimize': none,
  'window.toggleMaximize': none,
  'window.close': none,
  'window.state': none,
  'diagnostics.run': none,
  'diagnostics.copy': none,
  'app.info': none,
  'projects.openFile': strict({ projectPath, path: relPath }),
  'app.openExternal': strict({ url: z.string().min(1).max(2048) }),
} satisfies { [K in RendererRequestName]: z.ZodType<RendererRequests[K]['request']> };

export function isRendererRequest(name: unknown): name is RendererRequestName {
  return typeof name === 'string' && Object.prototype.hasOwnProperty.call(rendererSchemas, name);
}

export class IpcValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IpcValidationError';
  }
}

/** Checks a request from the renderer. Throws `IpcValidationError` with a readable reason. */
export function parseRendererRequest<K extends RendererRequestName>(name: K, payload: unknown): RendererRequests[K]['request'] {
  const schema = rendererSchemas[name] as z.ZodType;
  const parsed = schema.safeParse(payload ?? {});
  if (!parsed.success) {
    const why = parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ');
    throw new IpcValidationError(`Invalid "${name}" request: ${why}`);
  }
  return parsed.data as RendererRequests[K]['request'];
}
