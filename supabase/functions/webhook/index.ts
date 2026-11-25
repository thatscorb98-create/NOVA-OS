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

    await admin.from('email_events').insert({
      owner_id: message.owner_id,
      message_id: message.id,
      kind,
      detail: (body.detail ?? body.reason ?? '').slice(0, 500) || null,
      payload: body,
    });

    if (kind === 'bounced' || kind === 'complained' || kind === 'unsubscribed') {
      await admin.rpc('suppress_email', {
        p_email: message.to_email,
        p_reason:
          kind === 'unsubscribed' ? 'unsubscribe' : kind === 'complained' ? 'complaint' : 'bounce',
        p_note: `Recorded from a provider ${kind} event.`,
        p_owner_id: message.owner_id,
      });
    }

    if (kind === 'replied') {
      await admin
        .from('outreach_messages')
        .update({ status: 'replied' })
        .eq('id', message.id)
        .in('status', ['sent', 'delivered']);

      if (message.lead_id) {
        await admin
          .from('deals')
          .update({ stage: 'replied', next_action: 'Read the reply and answer it yourself.' })
          .eq('owner_id', message.owner_id)
          .eq('lead_id', message.lead_id)
          .in('stage', ['contacted', 'qualified']);
      }
    }

    return json({ ok: true, kind, messageId: message.id, version: SERVICE_VERSION });
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return fail(message, 500);
  }
});
