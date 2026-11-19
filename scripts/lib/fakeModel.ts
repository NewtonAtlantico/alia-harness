import OpenAI from 'openai';

/**
 * Scripted stand-in for the OpenAI client, so the agent loop can be tested deterministically
 * with no network and no API key. Each call to `chat.completions.create` consumes the next
 * scripted turn and records the request it received.
 */

export type ScriptedTurn =
  | {
      /** Final (or interleaved) assistant text. */
      content?: string;
      reasoning?: string;
      /** Tool calls the "model" requests this turn. `args` is JSON-stringified for you. */
      toolCalls?: { name: string; args?: unknown; id?: string }[];
    }
  /** Make the API call throw, like a network/server error. */
  | { throws: string }
  /**
   * The request never completes on its own, like a slow endpoint. 'honor-signal' rejects when the
   * caller's AbortSignal fires (a well-behaved client); 'ignore-signal' never settles (a client that
   * does not support cancellation).
   */
  | { hang: 'honor-signal' | 'ignore-signal' }
  /** Return a response with no choices, like a broken endpoint. */
  | { empty: true }
  /** Compute the turn from the request (e.g. to react to the previous tool result). */
  | ((req: RecordedRequest) => ScriptedTurn);

export interface RecordedRequest {
  model: string;
  /** Snapshot of the history as sent (later mutation by the agent does not affect it). */
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[];
  toolNames: string[];
  /** Whether the caller passed an AbortSignal in the request options. */
  signalPassed: boolean;
  /** Whether the request asked for a stream. */
  stream: boolean;
}

/** How the fake endpoint behaves when asked to stream. */
export type StreamBehaviour = 'ok' | 'refuse-400' | 'ignore-flag' | 'empty' | 'unauthorized' | 'slow';

export class FakeModel {
  readonly requests: RecordedRequest[] = [];
  private turns: ScriptedTurn[];
  private nextId = 1;
  /** Scripted turns used so far (a refused request does not count). */
  private served = 0;

  /**
   * @param turns scripted turns, consumed in order.
   * @param onExhausted what to do when the script runs out. 'throw' (default) fails the test
   *   loudly; 'repeat-last' replays the final turn forever (handy for step-cap tests).
   */
  constructor(turns: ScriptedTurn[], private onExhausted: 'throw' | 'repeat-last' = 'throw', private streaming: StreamBehaviour = 'ok') {
    this.turns = [...turns];
  }

  /** Cast target for `AgentOptions.client`. */
  get client(): OpenAI {
    return {
      chat: {
        completions: {
          create: async (params: any, options?: { signal?: AbortSignal }) => this.create(params, options),
        },
      },
    } as unknown as OpenAI;
  }

  get callCount(): number {
    return this.requests.length;
  }

  private async create(params: any, options?: { signal?: AbortSignal }): Promise<OpenAI.Chat.Completions.ChatCompletion> {
    const req: RecordedRequest = {
      model: params.model,
      messages: structuredClone(params.messages),
      toolNames: (params.tools ?? []).map((t: any) => t.function?.name),
      signalPassed: options?.signal !== undefined,
      stream: params.stream === true,
    };
    this.requests.push(req);

    // A request the endpoint refuses (a stream it cannot serve) does not use up a scripted turn: the repeat gets it.
    if (params.stream === true) {
      if (this.streaming === 'refuse-400') throw Object.assign(new Error('400 stream is not supported by this endpoint'), { status: 400 });
      if (this.streaming === 'unauthorized') throw Object.assign(new Error('401 Incorrect API key'), { status: 401 });
      if (this.streaming === 'empty') return (async function* () {})() as any;
    }

    const index = this.served++;
    let turn: ScriptedTurn | undefined = this.turns[index];
    if (!turn) {
      if (this.onExhausted === 'repeat-last' && this.turns.length > 0) {
        turn = this.turns[this.turns.length - 1];
      } else {
        throw new Error(`FakeModel: script exhausted at call #${index + 1}`);
      }
    }
    if (typeof turn === 'function') turn = turn(req);

    if ('hang' in turn) {
      return new Promise((_, reject) => {
        if (turn.hang !== 'honor-signal') return; // never settles
        const abort = () => reject(Object.assign(new Error('Request was aborted.'), { name: 'AbortError' }));
        if (options?.signal?.aborted) abort();
        else options?.signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if ('throws' in turn) throw new Error(turn.throws);
    if ('empty' in turn) return { id: 'fake', choices: [] } as unknown as OpenAI.Chat.Completions.ChatCompletion;

    const message: any = { role: 'assistant', content: turn.content ?? null };
    if (turn.reasoning) message.reasoning_content = turn.reasoning;
    if (turn.toolCalls?.length) {
      message.tool_calls = turn.toolCalls.map((tc) => ({
        id: tc.id ?? `call_${this.nextId++}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args ?? {}),
        },
      }));
    }
    const completion = {
      id: `fake-${index}`,
      object: 'chat.completion',
      created: 0,
      model: params.model,
      choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
    if (params.stream === true && this.streaming !== 'ignore-flag') return this.asStream(message, options?.signal) as any;
    return completion;
  }

  /** The same answer as a stream: the text in pieces of 4 characters, the reasoning in pieces, each tool call's arguments in two. */
  private async *asStream(message: any, signal?: AbortSignal): AsyncGenerator<any> {
    const slow = this.streaming === 'slow';
    const pause = async () => {
      if (!slow) return;
      await new Promise((r) => setTimeout(r, 40));
    };
    const chunk = (delta: any, finish: string | null = null) => ({ id: 'fake-stream', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
    const pieces = (text: string, n: number) => Array.from({ length: Math.ceil(text.length / n) }, (_, i) => text.slice(i * n, (i + 1) * n));
    yield chunk({ role: 'assistant' });
    for (const p of pieces(message.reasoning_content ?? '', 6)) {
      if (signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
      await pause();
      yield chunk({ reasoning_content: p });
    }
    for (const p of pieces(message.content ?? '', 4)) {
      if (signal?.aborted) throw Object.assign(new Error('Request was aborted.'), { name: 'AbortError' });
      await pause();
      yield chunk({ content: p });
    }
    for (const [i, tc] of (message.tool_calls ?? []).entries()) {
      const args: string = tc.function.arguments;
      const half = Math.ceil(args.length / 2);
      yield chunk({ tool_calls: [{ index: i, id: tc.id, type: 'function', function: { name: tc.function.name, arguments: args.slice(0, half) } }] });
      yield chunk({ tool_calls: [{ index: i, function: { arguments: args.slice(half) } }] });
    }
    yield chunk({}, message.tool_calls ? 'tool_calls' : 'stop');
  }
}
