import { resolveCaller } from '../_shared/auth.ts';
import { fail, json, methodNotAllowed, preflight } from '../_shared/http.ts';
import { adminClient, SERVICE_VERSION } from '../_shared/supabase.ts';

/**
 * Provider event hook.
 *
 * Called by the email provider (or by the owner's own relay) with the shared
 * worker secret. Events are recorded verbatim, and anything that means "do not
 * contact this address again" goes straight onto the suppression list, which
 * also cancels that address's open drafts.
 *
 * The handler never trusts the body for ownership: the message is looked up in
 * our own table, and the owner comes from that row.
 */

interface EventBody {
  type?: string;
  messageId?: string;
  providerMessageId?: string;
  to?: string;
  reason?: string;
  detail?: string;
  /** The reply text, when the provider supplies it. Only used for intent labels. */
  text?: string;
}

const KIND_BY_TYPE: Record<string, 'delivered' | 'bounced' | 'complained' | 'replied' | 'unsubscribed' | 'other'> = {
  delivered: 'delivered',
  delivery: 'delivered',
  bounce: 'bounced',
  bounced: 'bounced',
  complaint: 'complained',
  complained: 'complained',
  spam: 'complained',
  reply: 'replied',
  replied: 'replied',
  unsubscribe: 'unsubscribed',
  unsubscribed: 'unsubscribed',
};

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;

  if (req.method !== 'POST') return methodNotAllowed();

  const caller = await resolveCaller(req);
  if (!caller) return fail('Not authorized.', 401);
  if (caller.mode === 'user') {
    return fail('This hook accepts the cron secret or the service role only.', 403);
  }

  let body: EventBody;
  try {
    body = (await req.json()) as EventBody;
  } catch {
    return fail('A JSON body is required.');
  }

  const kind = KIND_BY_TYPE[(body.type ?? '').toLowerCase()] ?? 'other';

  try {
    const admin = adminClient();

    const query = admin
      .from('outreach_messages')
      .select('id, owner_id, to_email, lead_id, status')
      .limit(1);

    const { data: rows, error: lookupError } = body.messageId
      ? await query.eq('id', body.messageId)
      : body.providerMessageId
        ? await query.eq('provider_message_id', body.providerMessageId)
        : await query.eq('to_email', (body.to ?? '').toLowerCase());

    if (lookupError) throw new Error(lookupError.message);

    const message = (rows ?? [])[0] as
      | { id: string; owner_id: string; to_email: string; lead_id: string | null; status: string }
      | undefined;

    if (!message) {
      // Nothing of ours matches; record nothing rather than inventing a row.
      return json({ ok: true, ignored: true, reason: 'unknown message', version: SERVICE_VERSION });
    }

    // One database function owns the write path: it appends the event, derives a
    // deterministic intent from the reply text, suppresses an opt-out and moves
    // the deal only on a real reply. The handler never decides ownership.
    const { data: recorded, error: recordError } = await admin.rpc('record_email_event', {
      p_message_id: message.id,
      p_kind: kind,
      p_detail: (body.detail ?? body.reason ?? '').slice(0, 500) || null,
      p_text: typeof body.text === 'string' ? body.text.slice(0, 4000) : null,
      p_payload: body,
    });

    if (recordError) throw new Error(recordError.message);

    const result = (recorded ?? {}) as { intent?: string; suppressed?: boolean };

    return json({
      ok: true,
      kind,
      messageId: message.id,
      intent: result.intent ?? 'other',
      suppressed: result.suppressed === true,
      version: SERVICE_VERSION,
    });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(message, 500);
  }
});
