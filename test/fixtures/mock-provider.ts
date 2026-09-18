// Shared mock provider HTTP server used by every test that needs an OpenAI- or
// Anthropic-shaped upstream. Plain node:http, no framework, no mocking library.
// Bound to 127.0.0.1 on an OS-assigned port so many instances can run side by
// side in the test suite.
//
// Routes:
//   GET  /v1/models             -- shape picked from the path/headers, see detectShape()
//   POST /v1/chat/completions   -- OpenAI Chat Completions (JSON or SSE)
//   POST /v1/messages           -- Anthropic Messages (JSON or SSE)
//
// Nothing else in the repo should re-implement these response shapes: import this
// fixture instead.

import type { IncomingHttpHeaders, IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

export interface FailWithOptions {
  readonly status: number;
  readonly message?: string;
  readonly type?: string;
  readonly code?: string;
}

export interface ScriptedToolCall {
  readonly name: string;
  readonly arguments?: Record<string, unknown>;
}

export interface ScriptedResponse {
  /** Assistant text (or the JSON string when jsonMode is true). */
  readonly content?: string;
  /** Answer with a tool call instead of text. */
  readonly toolCall?: ScriptedToolCall;
  /** Answer in JSON mode; content defaults to a small JSON object. */
  readonly jsonMode?: boolean;
  /** Model id reported in the response, overriding the requested one. */
  readonly model?: string;
  /** Fail this one call with this status and a provider-shaped error body. */
  readonly failWith?: FailWithOptions;
}

export interface ModelLists {
  readonly openai?: readonly string[];
  readonly anthropic?: readonly string[];
}

export interface StartMockProviderOptions {
  /** Delay, in milliseconds, before any response (including headers) is sent. */
  readonly latencyMs?: number;
  /** Extra delay, in milliseconds, between the (already sent) headers and the first streamed chunk. */
  readonly firstByteDelayMs?: number;
  /** When set, every request fails with this status and a provider-shaped error body. */
  readonly failWith?: FailWithOptions;
  /** When true, the connection is accepted and never answered (for timeout tests). */
  readonly hang?: boolean;
  /** Delay, in milliseconds, between two streamed frames (after the first one). */
  readonly chunkDelayMs?: number;
  /** When true, a streaming response is cut off mid-stream, before its terminal frame. */
  readonly dropMidStream?: boolean;
  /** Model ids returned by GET /v1/models, per shape. */
  readonly models?: ModelLists;
  /** Scripted responses consumed in call order for POST /v1/chat/completions and /v1/messages. */
  readonly responses?: readonly ScriptedResponse[];
}

/** What the mock wrote for one streamed response. */
export interface RecordedStream {
  /** The exact body text written so far. */
  readonly text: string;
  /** performance.now() when the first frame was flushed to the socket; null before that. */
  readonly firstFrameAt: number | null;
}

export interface MockProvider {
  readonly url: string;
  readonly requests: RecordedRequest[];
  /** One entry per streamed response, in the order the streams started. */
  readonly streams: readonly RecordedStream[];
  /** Resolves once the connection that carried requests[index] is closed (by either side). */
  waitForDisconnect(index: number): Promise<void>;
  close(): Promise<void>;
}

const DEFAULT_OPENAI_MODELS: readonly string[] = ['mock-openai-fast', 'mock-openai-quality'];
const DEFAULT_ANTHROPIC_MODELS: readonly string[] = ['mock-anthropic-fast', 'mock-anthropic-quality'];

let idCounter = 0;

/** Resolves once a connection closes; one per connection. */
const socketClosed = new WeakMap<Socket, Promise<void>>();

function nextId(prefix: string): string {
  idCounter += 1;
  return `${prefix}-mock-${idCounter}`;
}

function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseBody(raw: Buffer): unknown {
  if (raw.length === 0) return undefined;
  const text = raw.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload).toString(),
  });
  res.end(payload);
}

function openAiErrorBody(opts: FailWithOptions): unknown {
  return {
    error: {
      message: opts.message ?? `mock provider error (status ${opts.status})`,
      type: opts.type ?? 'mock_error',
      code: opts.code ?? String(opts.status),
    },
  };
}

function anthropicErrorBody(opts: FailWithOptions): unknown {
  return {
    type: 'error',
    error: {
      type: opts.type ?? 'mock_error',
      message: opts.message ?? `mock provider error (status ${opts.status})`,
    },
  };
}

type Shape = 'openai' | 'anthropic';

function detectShape(pathname: string, headers: IncomingHttpHeaders): Shape {
  if (pathname.startsWith('/v1/messages')) return 'anthropic';
  if (pathname.startsWith('/v1/chat/completions')) return 'openai';
  if (headers['anthropic-version'] !== undefined || headers['x-api-key'] !== undefined) return 'anthropic';
  return 'openai';
}

/**
 * Splits text into streaming pieces without losing or altering a single character:
 * `splitIntoChunks(text).join('') === text` for every input. Each piece is a run of
 * whitespace or up to two words together with the whitespace that follows them, so
 * leading, trailing and repeated whitespace (spaces, tabs, newlines) are kept as-is.
 * An empty string yields one empty piece, so a stream always carries one delta.
 */
export function splitIntoChunks(text: string): string[] {
  const tokens = text.match(/\S+\s*|\s+/g);
  if (tokens === null) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < tokens.length; i += 2) {
    chunks.push(tokens.slice(i, i + 2).join(''));
  }
  return chunks;
}

interface ResolvedContent {
  readonly kind: 'text' | 'json' | 'tool_call';
  readonly text?: string;
  readonly toolName?: string;
  readonly toolArguments?: Record<string, unknown>;
}

function resolveContent(body: unknown, script: ScriptedResponse | undefined): ResolvedContent {
  const record = asRecord(body);

  // A scripted response always wins over what the request body would trigger.
  if (script?.toolCall) {
    return { kind: 'tool_call', toolName: script.toolCall.name, toolArguments: script.toolCall.arguments ?? {} };
  }
  if (script?.jsonMode === true) {
    return { kind: 'json', text: script.content ?? JSON.stringify({ mock: true }) };
  }
  if (script?.content !== undefined) {
    return { kind: 'text', text: script.content };
  }

  const tools = record?.tools;
  if (Array.isArray(tools) && tools.length > 0) {
    const first = asRecord(tools[0]);
    // OpenAI tools are shaped { type: 'function', function: { name, parameters } };
    // Anthropic tools are shaped { name, input_schema } directly.
    const fn = asRecord(first?.function);
    const name = typeof fn?.name === 'string' ? fn.name : typeof first?.name === 'string' ? first.name : 'mock_tool';
    return { kind: 'tool_call', toolName: name, toolArguments: {} };
  }

  const responseFormat = asRecord(record?.response_format);
  const formatType = responseFormat?.type;
  if (formatType === 'json_object' || formatType === 'json_schema') {
    return { kind: 'json', text: JSON.stringify({ mock: true }) };
  }

  return { kind: 'text', text: 'Mock response from the mock provider.' };
}

function resolveModel(record: Record<string, unknown> | undefined, script: ScriptedResponse | undefined): string {
  if (script?.model !== undefined) return script.model;
  const modelValue = record?.model;
  return typeof modelValue === 'string' ? modelValue : 'mock-model';
}

function buildOpenAiCompletionBody(model: string, content: ResolvedContent): unknown {
  const id = nextId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);

  if (content.kind === 'tool_call') {
    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: nextId('call'),
                type: 'function',
                function: { name: content.toolName, arguments: JSON.stringify(content.toolArguments ?? {}) },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }

  return {
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: content.text ?? '' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function buildAnthropicMessageBody(model: string, content: ResolvedContent): unknown {
  const id = nextId('msg');

  if (content.kind === 'tool_call') {
    return {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [{ type: 'tool_use', id: nextId('toolu'), name: content.toolName, input: content.toolArguments ?? {} }],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
    };
  }

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [{ type: 'text', text: content.text ?? '' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 5 },
  };
}

function openAiModelsBody(models: readonly string[]): unknown {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: models.map((id) => ({ id, object: 'model', created, owned_by: 'mock-provider' })),
  };
}

function anthropicModelsBody(models: readonly string[]): unknown {
  const createdAt = new Date().toISOString();
  return {
    data: models.map((id) => ({ type: 'model', id, display_name: id, created_at: createdAt })),
    has_more: false,
    first_id: models[0] ?? null,
    last_id: models[models.length - 1] ?? null,
  };
}

/** The record of one streamed response, filled in as frames are written. */
interface StreamRecord {
  text: string;
  firstFrameAt: number | null;
  frames: number;
  readonly chunkDelayMs: number;
}

/** Writes raw body text, after chunkDelayMs when it is not the first frame, and resolves once it
 *  has been flushed to the socket, so a caller that destroys the connection right after
 *  (dropMidStream) is guaranteed the frame was actually sent first. */
async function writeFrameText(res: ServerResponse, record: StreamRecord, text: string): Promise<void> {
  if (record.frames > 0) await delay(record.chunkDelayMs);
  record.frames += 1;
  record.text += text;
  await new Promise<void>((resolve, reject) => {
    res.write(text, (err) => {
      if (err) {
        reject(err);
        return;
      }
      record.firstFrameAt ??= performance.now();
      resolve();
    });
  });
}

/** Writes one SSE frame (see writeFrameText). */
function writeSseFrame(
  res: ServerResponse,
  record: StreamRecord,
  event: string | undefined,
  data: unknown,
): Promise<void> {
  const eventLine = event === undefined ? '' : `event: ${event}\n`;
  return writeFrameText(res, record, `${eventLine}data: ${JSON.stringify(data)}\n\n`);
}

async function streamOpenAi(
  res: ServerResponse,
  model: string,
  content: ResolvedContent,
  includeUsage: boolean,
  opts: StartMockProviderOptions,
  record: StreamRecord,
): Promise<void> {
  const id = nextId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Send the status line and headers now, so firstByteDelayMs delays only the body.
  res.flushHeaders();

  await delay(opts.firstByteDelayMs ?? 0);

  const chunk = (choiceFields: Record<string, unknown>) =>
    writeSseFrame(res, record, undefined, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, ...choiceFields }],
    });

  await chunk({ delta: { role: 'assistant' }, finish_reason: null });

  if (opts.dropMidStream) {
    res.destroy();
    return;
  }

  if (content.kind === 'tool_call') {
    const callId = nextId('call');
    await chunk({
      delta: {
        tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: content.toolName, arguments: '' } }],
      },
      finish_reason: null,
    });
    const argsText = JSON.stringify(content.toolArguments ?? {});
    for (const piece of splitIntoChunks(argsText)) {
      await chunk({ delta: { tool_calls: [{ index: 0, function: { arguments: piece } }] }, finish_reason: null });
    }
    await chunk({ delta: {}, finish_reason: 'tool_calls' });
  } else {
    for (const piece of splitIntoChunks(content.text ?? '')) {
      await chunk({ delta: { content: piece }, finish_reason: null });
    }
    await chunk({ delta: {}, finish_reason: 'stop' });
  }

  if (includeUsage) {
    await writeSseFrame(res, record, undefined, {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
  }

  await writeFrameText(res, record, 'data: [DONE]\n\n');
  res.end();
}

async function streamAnthropic(
  res: ServerResponse,
  model: string,
  content: ResolvedContent,
  opts: StartMockProviderOptions,
  record: StreamRecord,
): Promise<void> {
  const id = nextId('msg');

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  // Send the status line and headers now, so firstByteDelayMs delays only the body.
  res.flushHeaders();

  await delay(opts.firstByteDelayMs ?? 0);

  await writeSseFrame(res, record, 'message_start', {
    type: 'message_start',
    message: {
      id,
      type: 'message',
      role: 'assistant',
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  });

  if (opts.dropMidStream) {
    res.destroy();
    return;
  }

  if (content.kind === 'tool_call') {
    const toolId = nextId('toolu');
    await writeSseFrame(res, record, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: content.toolName, input: {} },
    });
    const argsText = JSON.stringify(content.toolArguments ?? {});
    for (const piece of splitIntoChunks(argsText)) {
      await writeSseFrame(res, record, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: piece },
      });
    }
    await writeSseFrame(res, record, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    await writeSseFrame(res, record, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  } else {
    await writeSseFrame(res, record, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    });
    for (const piece of splitIntoChunks(content.text ?? '')) {
      await writeSseFrame(res, record, 'content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: piece },
      });
    }
    await writeSseFrame(res, record, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    await writeSseFrame(res, record, 'message_delta', {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 5 },
    });
  }

  await writeSseFrame(res, record, 'message_stop', { type: 'message_stop' });
  res.end();
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: StartMockProviderOptions,
  requests: RecordedRequest[],
  responseQueue: ScriptedResponse[],
  disconnects: Promise<void>[],
  streams: StreamRecord[],
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  const rawBody = await readBody(req);
  const body = parseBody(rawBody);

  requests.push({ method, path: url.pathname, headers: { ...req.headers }, body });
  const socket = req.socket;
  // One close listener per connection, shared by every request a keep-alive connection carries.
  let closed = socketClosed.get(socket);
  if (closed === undefined) {
    closed = socket.destroyed ? Promise.resolve() : new Promise((resolve) => socket.once('close', () => resolve()));
    socketClosed.set(socket, closed);
  }
  disconnects.push(closed);

  if (opts.hang) {
    // Never respond: the socket is left open on purpose so the caller can exercise
    // its own timeout logic. startMockProvider().close() force-closes it.
    return;
  }

  await delay(opts.latencyMs ?? 0);

  const shape = detectShape(url.pathname, req.headers);

  if (opts.failWith) {
    const errorBody = shape === 'openai' ? openAiErrorBody(opts.failWith) : anthropicErrorBody(opts.failWith);
    sendJson(res, opts.failWith.status, errorBody);
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/models') {
    const models =
      shape === 'openai'
        ? (opts.models?.openai ?? DEFAULT_OPENAI_MODELS)
        : (opts.models?.anthropic ?? DEFAULT_ANTHROPIC_MODELS);
    sendJson(res, 200, shape === 'openai' ? openAiModelsBody(models) : anthropicModelsBody(models));
    return;
  }

  if (method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/messages')) {
    const script = responseQueue.shift();
    if (script?.failWith) {
      const errorBody = shape === 'openai' ? openAiErrorBody(script.failWith) : anthropicErrorBody(script.failWith);
      sendJson(res, script.failWith.status, errorBody);
      return;
    }
    const record = asRecord(body);
    const model = resolveModel(record, script);
    const content = resolveContent(body, script);
    const wantsStream = record?.stream === true;
    const newStream = (): StreamRecord => {
      const stream: StreamRecord = { text: '', firstFrameAt: null, frames: 0, chunkDelayMs: opts.chunkDelayMs ?? 0 };
      streams.push(stream);
      return stream;
    };

    if (shape === 'openai') {
      if (wantsStream) {
        const streamOptions = asRecord(record?.stream_options);
        const includeUsage = streamOptions?.include_usage === true;
        await streamOpenAi(res, model, content, includeUsage, opts, newStream());
      } else {
        sendJson(res, 200, buildOpenAiCompletionBody(model, content));
      }
    } else if (wantsStream) {
      await streamAnthropic(res, model, content, opts, newStream());
    } else {
      sendJson(res, 200, buildAnthropicMessageBody(model, content));
    }
    return;
  }

  const notFound: FailWithOptions = {
    status: 404,
    message: `unknown mock route ${method} ${url.pathname}`,
    type: 'invalid_request_error',
  };
  sendJson(res, 404, shape === 'openai' ? openAiErrorBody(notFound) : anthropicErrorBody(notFound));
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

export function startMockProvider(opts: StartMockProviderOptions = {}): Promise<MockProvider> {
  const requests: RecordedRequest[] = [];
  const responseQueue: ScriptedResponse[] = [...(opts.responses ?? [])];
  const disconnects: Promise<void>[] = [];
  const streams: StreamRecord[] = [];

  const server = createServer((req, res) => {
    handleRequest(req, res, opts, requests, responseQueue, disconnects, streams).catch((error: unknown) => {
      if (!res.headersSent) {
        sendJson(res, 500, { error: { message: String(error), type: 'mock_internal_error', code: '500' } });
      } else {
        res.destroy();
      }
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('mock provider failed to bind to a loopback TCP port'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        streams,
        waitForDisconnect: (index: number) => {
          const disconnect = disconnects[index];
          if (disconnect === undefined) return Promise.reject(new Error(`no recorded request at index ${index}`));
          return disconnect;
        },
        close: () => closeServer(server),
      });
    });
  });
}
