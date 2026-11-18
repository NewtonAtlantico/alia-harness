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
}

export class FakeModel {
  readonly requests: RecordedRequest[] = [];
  private turns: ScriptedTurn[];
  private nextId = 1;

  /**
   * @param turns scripted turns, consumed in order.
   * @param onExhausted what to do when the script runs out. 'throw' (default) fails the test
   *   loudly; 'repeat-last' replays the final turn forever (handy for step-cap tests).
   */
  constructor(turns: ScriptedTurn[], private onExhausted: 'throw' | 'repeat-last' = 'throw') {
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
    };
    this.requests.push(req);

    const index = this.requests.length - 1;
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
    return {
      id: `fake-${index}`,
      object: 'chat.completion',
      created: 0,
      model: params.model,
      choices: [{ index: 0, finish_reason: message.tool_calls ? 'tool_calls' : 'stop', message }],
    } as unknown as OpenAI.Chat.Completions.ChatCompletion;
  }
}
