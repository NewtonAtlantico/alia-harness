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
  'projects.pick': none,
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
