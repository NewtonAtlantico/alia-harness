/// <reference types="electron" />
/**
 * Entry point of the engine process: connects the runtime to the message port of the utility process.
 * Requests are answered concurrently (a run does not block a cancel), and each gets exactly one reply.
 */
import type { EngineMessage, EngineReplyMessage, EngineRequestMessage } from '../shared/ipc';
import { EngineRuntime } from './runtime';

const port = process.parentPort;
const runtime = new EngineRuntime({ post: (message) => port.postMessage(message satisfies EngineMessage) });

port.on('message', async (event) => {
  const msg = event.data as EngineRequestMessage;
  if (msg?.kind !== 'request') return;
  let reply: EngineReplyMessage;
  try {
    reply = { kind: 'reply', id: msg.id, ok: true, result: await runtime.handle(msg.name, msg.payload as never) };
  } catch (err: any) {
    reply = { kind: 'reply', id: msg.id, ok: false, error: String(err?.message ?? err) };
  }
  port.postMessage(reply);
});

process.on('uncaughtException', (err) => {
  console.error('engine: uncaught exception', err);
  process.exit(1); // main restarts the engine; saved conversations are on disk
});
process.on('unhandledRejection', (err) => {
  console.error('engine: unhandled rejection', err);
  process.exit(1);
});

port.postMessage({ kind: 'ready' } satisfies EngineMessage);
