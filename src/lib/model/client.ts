import { NIM_BASE_URL } from '@/lib/model/models';

/**
 * Minimal, dependency-free client for NVIDIA NIM's OpenAI-compatible API.
 * Non-streaming on purpose: reliable on mobile networks and easier to persist.
 */

export type ModelErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'model'
  | 'network'
  | 'timeout'
  | 'server'
  | 'invalid'
  | 'config';

export class ModelError extends Error {
  readonly kind: ModelErrorKind;
  readonly status?: number;

  constructor(message: string, kind: ModelErrorKind, status?: number) {
    super(message);
    this.name = 'ModelError';
    this.kind = kind;
    this.status = status;
  }
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ModelToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export type ModelRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ModelMessage {
  role: ModelRole;
  content: string | null;
  tool_calls?: {
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }[];
  tool_call_id?: string;
}

export interface CompletionResult {
  text: string;
  toolCalls: ModelToolCall[];
  model: string;
}

interface ChatCompletionOptions {
  apiKey: string;
  model: string;
  messages: ModelMessage[];
  tools?: ModelToolDefinition[];
  temperature?: number;
  maxTokens?: number;
}

const TIMEOUT_MS = 120_000;

export async function chatCompletion({
  apiKey,
  model,
  messages,
  tools,
  temperature = 0.4,
  maxTokens = 1400,
}: ChatCompletionOptions): Promise<CompletionResult> {
  if (!apiKey) {
    throw new ModelError('No NVIDIA NIM API key is stored on this device.', 'config');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const payload: Record<string, unknown> = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    stream: false,
  };

  // No tool_choice: the NIM default is auto, and some deployments reject the
  // explicit field unless their tool-call parser was configured for it.
  if (tools && tools.length > 0) {
    payload.tools = tools;
  }

  let response: Response;

  try {
    response = await fetch(`${NIM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ModelError('The model took too long to respond.', 'timeout');
    }
    throw new ModelError(
      'Could not reach NVIDIA. Check the phone\'s internet connection and try again.',
      'network',
    );
  } finally {
    clearTimeout(timeout);
  }

  const raw = await response.text();

  if (!response.ok) {
    throw mapHttpError(response.status, raw, model);
  }

  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new ModelError('The model returned an unreadable response.', 'invalid');
  }

  const choice = (data as { choices?: { message?: Record<string, unknown> }[] }).choices?.[0];
  const message = choice?.message ?? {};

  const text = extractText(message.content);
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

  const toolCalls: ModelToolCall[] = rawCalls.map((call, index) => {
    const entry = call as {
      id?: string;
      function?: { name?: string; arguments?: unknown };
    };
    const rawArguments = entry.function?.arguments;

    return {
      id: entry.id ?? `call_${index}`,
      name: entry.function?.name ?? '',
      arguments:
        typeof rawArguments === 'string'
          ? rawArguments
          : JSON.stringify(rawArguments ?? {}),
    };
  });

  return {
    text,
    toolCalls: toolCalls.filter((call) => call.name.length > 0),
    model:
      (data as { model?: string }).model ??
      model,
  };
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('')
      .trim();
  }

  return '';
}

function mapHttpError(status: number, raw: string, model: string): ModelError {
  let detail = '';

  try {
    const parsed = JSON.parse(raw) as { detail?: unknown; title?: unknown; message?: unknown };
    const candidate = parsed.detail ?? parsed.message ?? parsed.title;
    if (typeof candidate === 'string') detail = candidate;
  } catch {
    detail = raw.slice(0, 200);
  }

  if (status === 401 || status === 403) {
    return new ModelError(
      'NVIDIA rejected the API key. Open Core settings and paste a valid key from build.nvidia.com.',
      'auth',
      status,
    );
  }

  if (status === 404 || status === 410) {
    return new ModelError(
      `The model "${model}" is not available on your account. Choose another model in Core settings.`,
      'model',
      status,
    );
  }

  if (status === 429) {
    return new ModelError(
      'NVIDIA rate limit reached (about 40 requests per minute on the free tier). Wait a moment and try again.',
      'rate_limit',
      status,
    );
  }

  if (status >= 500) {
    return new ModelError(
      detail
        ? `NVIDIA reported a server error: ${detail}`
        : 'NVIDIA is having a server problem. Try again shortly.',
      'server',
      status,
    );
  }

  return new ModelError(
    detail ? `NVIDIA request failed (${status}): ${detail}` : `NVIDIA request failed (${status}).`,
    'invalid',
    status,
  );
}

/** Human-readable message for any error thrown by the model layer. */
export function describeModelError(error: unknown): string {
  if (error instanceof ModelError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Something went wrong while contacting the model.';
}
