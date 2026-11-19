import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local OpenAI-compatible endpoint for driving the real app without a network or an API key: it answers
 * `POST /chat/completions` with scripted turns and `GET /models` with a fixed list. A turn is a plain object or
 * a function of the request (to react to the previous tool result). Grows into the A16 test harness.
 */
export interface FakeTurn {
  content?: string;
  toolCalls?: Array<{ name: string; args?: unknown; id?: string }>;
}
export type FakeTurnSource = FakeTurn | ((request: { messages: any[] }) => FakeTurn);

export interface FakeServer {
  /** Base URL to put in the config (`url`). */
  url: string;
  requests: Array<{ model: string; messages: any[] }>;
  close(): Promise<void>;
}

export interface FakeServerOptions {
  /** When set, requests without `Authorization: Bearer <apiKey>` get a 401, like a real endpoint. */
  apiKey?: string;
}

export async function startFakeServer(turns: FakeTurnSource[], options: FakeServerOptions = {}): Promise<FakeServer> {
  const queue = [...turns];
  const requests: FakeServer['requests'] = [];
  let ids = 0;

  const server = http.createServer((req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (options.apiKey && req.headers.authorization !== `Bearer ${options.apiKey}`) {
      return send(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } });
    }
    if (req.method === 'GET' && req.url === '/models') {
      return send(200, { object: 'list', data: [{ id: 'fake-model', object: 'model' }] });
    }
    if (req.method === 'POST' && req.url === '/chat/completions') {
      let raw = '';
      req.on('data', (d) => (raw += d));
      req.on('end', () => {
        const body = JSON.parse(raw);
        requests.push({ model: body.model, messages: body.messages });
        const next = queue.shift();
        if (!next) return send(500, { error: { message: 'the fake server ran out of scripted turns' } });
        const turn = typeof next === 'function' ? next({ messages: body.messages }) : next;
        const toolCalls = (turn.toolCalls ?? []).map((c) => ({
          id: c.id ?? `call_${++ids}`,
          type: 'function',
          function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args ?? {}) },
        }));
        send(200, {
          id: `chatcmpl-${++ids}`,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: body.model,
          choices: [{ index: 0, finish_reason: toolCalls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: turn.content ?? null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      });
      return;
    }
    send(404, { error: { message: `not found: ${req.method} ${req.url}` } });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    requests,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
