import { env } from '../supabase.ts';

/**
 * AgentMail client.
 *
 * The API key lives in function secrets only. With no key the client throws
 * ProviderNotConfigured, and the send handler fails closed with a message that
 * says so — it never pretends an email went out.
 *
 * The single send path is wrapped in one function on purpose: when the key is
 * added, this is the only place that needs checking against the provider's
 * current contract.
 */

export class ProviderNotConfigured extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderNotConfigured';
  }
}

const DEFAULT_BASE_URL = 'https://api.agentmail.to/v0';
const TIMEOUT_MS = 20_000;

export interface EmailProviderStatus {
  configured: boolean;
  provider: 'agentmail';
  reason: string;
}

export interface SendEmailInput {
  inboxId: string;
  to: string;
  subject: string;
  text: string;
  replyTo?: string | null;
}

export interface SendEmailResult {
  providerMessageId: string;
  providerThreadId: string | null;
}

export function emailProviderStatus(): EmailProviderStatus {
  return env('AGENTMAIL_API_KEY')
    ? { configured: true, provider: 'agentmail', reason: 'AgentMail is configured.' }
    : {
        configured: false,
        provider: 'agentmail',
        reason: 'AGENTMAIL_API_KEY is not set on this project, so no email can be sent.',
      };
}

function baseUrl(): string {
  return (env('AGENTMAIL_BASE_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function authHeaders(): Record<string, string> {
  const key = env('AGENTMAIL_API_KEY');
  if (!key) throw new ProviderNotConfigured(emailProviderStatus().reason);

  return {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    Authorization: `Bearer ${key}`,
  };
}

async function readError(response: Response): Promise<string> {
  const body = (await response.text()).slice(0, 400);
  return `AgentMail returned HTTP ${response.status}: ${body || 'no body'}`;
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const inbox = (input.inboxId ?? '').trim();
  if (!inbox) throw new ProviderNotConfigured('No AgentMail inbox id is configured for this sender.');

  const response = await fetch(
    `${baseUrl()}/inboxes/${encodeURIComponent(inbox)}/messages/send`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );

  if (!response.ok) throw new Error(await readError(response));

  const data = (await response.json()) as {
    message_id?: string;
    id?: string;
    thread_id?: string;
    thread?: { id?: string };
  };

  const providerMessageId = data.message_id ?? data.id ?? '';
  if (!providerMessageId) {
    // A 2xx without an id cannot be recorded as a real send.
    throw new Error('AgentMail accepted the request but returned no message id.');
  }

  return {
    providerMessageId,
    providerThreadId: data.thread_id ?? data.thread?.id ?? null,
  };
}
