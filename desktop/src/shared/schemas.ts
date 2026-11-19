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

/** The address of the model endpoint: http(s) only, no credentials in it. */
export const endpointUrl = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .refine((v) => {
    try {
      const u = new URL(v);
      return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname && !u.username && !u.password;
    } catch {
      return false;
    }
  }, 'must be an http or https address without a user name or password');

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
  'projects.recent': none,
  'settings.get': none,
  'settings.update': strict({
    displayName: z.string().trim().max(100).optional(),
    organization: z.string().trim().max(100).optional(),
    endpointUrl: endpointUrl.optional(),
    models: z.array(modelSetting).min(1, 'at least one model is needed').max(50).optional(),
    permissionMode: z.enum(['ask-dangerous', 'ask-commands', 'auto']).optional(),
  }),
  'settings.setApiKey': strict({ apiKey: z.string().trim().min(8, 'that looks too short to be an API key').max(4096) }),
  'settings.clearApiKey': none,
  'settings.testConnection': strict({ endpointUrl: endpointUrl.optional(), apiKey: z.string().trim().min(1).max(4096).optional() }),
  'settings.legacyCandidate': none,
  'settings.importLegacy': none,
  'window.minimize': none,
  'window.toggleMaximize': none,
  'window.close': none,
  'window.state': none,
  'app.info': none,
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
