import type { JobContext, JobHandler } from '../jobs.ts';
import { emailProviderStatus, ProviderNotConfigured, sendEmail } from '../providers/agentmail.ts';

/**
 * Phase 7: send the delivery email.
 *
 *   relay.send_delivery → a private link to the files that passed SENTINEL
 *
 * This is transactional mail for a customer who has already paid, so it does
 * not consume the outreach daily cap. It still needs the owner's email switch,
 * a configured provider and a verified sending account, and it never marks a
 * delivery complete unless the provider returned a message id.
 *
 * The email body stores the only plaintext copy of the link. The database keeps
 * a hash, so a retry after a successful send cannot mint or leak a second link.
 */

interface DeliverableRow {
  id: string;
  owner_id: string;
  quote_id: string;
  lead_id: string | null;
  title: string;
  scope: string;
  status: string;
  revisions_included: number;
  revisions_used: number;
  artifact_url: string | null;
  delivery_message_id: string | null;
}

interface QuoteRow {
  id: string;
  title: string;
  deliverables: string;
  terms: string;
  amount_cents: number;
  currency: string;
}

interface SettingsRow {
  autonomy_mode: string;
  email_enabled: boolean;
  company_name: string;
}

interface AccountRow {
  from_name: string | null;
  from_email: string | null;
  reply_to: string | null;
  inbox_id: string | null;
  verified: boolean;
  enabled: boolean;
}

interface MessageRow {
  id: string;
  status: string;
  to_email: string;
  subject: string;
  body: string;
  lead_id: string | null;
}

const LINK_DAYS = 14;

function hashToken(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token);
  return crypto.subtle.digest('SHA-256', bytes).then((digest) =>
    Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(''),
  );
}

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function deliveryUrl(token: string): string {
  const base = (Deno.env.get('SUPABASE_URL') ?? '').replace(/\/+$/, '');
  if (!base) throw new Error('SUPABASE_URL is not set, so the delivery link cannot be built.');
  return `${base}/functions/v1/delivery?token=${token}`;
}

function formatDate(value: string): string {
  return new Date(value).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}

function money(cents: number, currency: string): string {
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `;
  return `${symbol}${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

export const relaySendDelivery: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const deliverableId =
    typeof ctx.job.payload.deliverableId === 'string' ? ctx.job.payload.deliverableId : '';

  if (!deliverableId) throw new Error('relay.send_delivery needs a deliverableId.');

  const { data: deliverable, error: deliverableError } = await ctx.admin
    .from('deliverables')
    .select(
      'id, owner_id, quote_id, lead_id, title, scope, status, revisions_included, revisions_used, artifact_url, delivery_message_id',
    )
    .eq('id', deliverableId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (deliverableError) throw new Error(`Could not load the delivery: ${deliverableError.message}`);
  if (!deliverable) throw new Error('That delivery no longer exists for this owner.');

  const delivery = deliverable as DeliverableRow;
  if (['delivered', 'accepted'].includes(delivery.status)) {
    return { skipped: true, reason: 'already_delivered' };
  }
  if (!['pending', 'in_progress', 'revision_requested'].includes(delivery.status)) {
    throw new Error(`Delivery status is "${delivery.status}"; it cannot be sent.`);
  }

  const { data: settings, error: settingsError } = await ctx.admin
    .from('business_settings')
    .select('autonomy_mode, email_enabled, company_name')
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (settingsError) throw new Error(`Could not read business settings: ${settingsError.message}`);
  if (!settings) throw new Error('No business settings exist for this owner yet.');

  const config = settings as SettingsRow;
  if (config.autonomy_mode === 'paused') {
    throw new Error('The company is paused, so no delivery email was sent.');
  }
  if (!config.email_enabled) {
    throw new Error('Email is switched off, so no delivery email was sent.');
  }

  const provider = emailProviderStatus();
  if (!provider.configured) throw new Error(provider.reason);

  const { data: account, error: accountError } = await ctx.admin
    .from('email_accounts')
    .select('from_name, from_email, reply_to, inbox_id, verified, enabled')
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (accountError) throw new Error(`Could not read the sending account: ${accountError.message}`);
  if (!account) throw new Error('No sending account exists for this owner.');
  const sender = account as AccountRow;
  if (!sender.enabled || !sender.verified) {
    throw new Error('The sending account is not enabled and verified, so nothing was sent.');
  }
  if (!sender.inbox_id) {
    throw new Error('The sending account has no inbox id, so AgentMail cannot be addressed.');
  }

  const { data: job } = await ctx.admin
    .from('production_jobs')
    .select('id, status, version')
    .eq('quote_id', delivery.quote_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!job || job.status !== 'ready') {
    throw new Error('Production has not passed QA, so there is nothing to deliver yet.');
  }

  const { data: files } = await ctx.admin
    .from('production_files')
    .select('name, bytes, sha256')
    .eq('job_id', job.id)
    .eq('version', job.version)
    .order('name');

  if (!files || files.length === 0) {
    throw new Error('The production job has no stored files to deliver.');
  }

  const { data: quote, error: quoteError } = await ctx.admin
    .from('quotes')
    .select('id, title, deliverables, terms, amount_cents, currency')
    .eq('id', delivery.quote_id)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (quoteError) throw new Error(`Could not load the quote: ${quoteError.message}`);
  if (!quote) throw new Error('The quote behind this delivery no longer exists.');
  const quoteRow = quote as QuoteRow;

  const { data: contact } = delivery.lead_id
    ? await ctx.admin
        .from('contacts')
        .select('id, name, email, opted_out')
        .eq('owner_id', ownerId)
        .eq('lead_id', delivery.lead_id)
        .not('email', 'is', null)
        .order('opted_out', { ascending: true })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle()
    : { data: null };

  if (!contact?.email) {
    throw new Error('This customer has no contact email, so the delivery cannot be sent.');
  }

  // Transactional mail for a paid order: a marketing opt-out does not erase the
  // customer's right to receive the work they bought.
  const accountEmail = String(contact.email).trim();
  const accountName = String(contact.name ?? '').trim();

  const key = `delivery:${delivery.id}`;
  const { data: existing } = await ctx.admin
    .from('outreach_messages')
    .select('id, status, to_email, subject, body, lead_id')
    .eq('owner_id', ownerId)
    .eq('idempotency_key', key)
    .maybeSingle();

  const previous = existing as MessageRow | null;

  if (previous?.status === 'sent') {
    await finishDelivery(ctx, delivery, previous.id, job.id, delivery.artifact_url ?? '');
    return { skipped: true, reason: 'already_sent', messageId: previous.id };
  }

  const token = randomToken();
  const expiresAt = new Date(Date.now() + LINK_DAYS * 86_400_000);
  const { data: link, error: linkError } = await ctx.admin.rpc('create_delivery_link', {
    p_deliverable_id: delivery.id,
    p_token_hash: await hashToken(token),
    p_expires_at: expiresAt.toISOString(),
  });

  const created = (Array.isArray(link) ? link[0] : link) as { id?: string } | null;
  if (linkError || !created?.id) {
    throw new Error(`Could not create the delivery link: ${linkError?.message ?? 'unknown error'}`);
  }

  const url = deliveryUrl(token);
  const remaining = Math.max(0, delivery.revisions_included - delivery.revisions_used);
  const fileList = (files as Array<{ name: string; bytes: number }>)
    .map((file) => `- ${file.name} (${Math.max(1, Math.round(Number(file.bytes) / 1024))} KB)`)
    .join('\n');

  const subject = `Your ${delivery.title} is ready`;
  const body = [
    `Hi ${accountName || 'there'},`,
    '',
    `${quoteRow.title || delivery.title} is ready.`,
    '',
    `What you are receiving:`,
    quoteRow.deliverables || delivery.scope || delivery.title,
    '',
    'Files:',
    fileList,
    '',
    'Download your files:',
    url,
    '',
    `This link is private to you and expires on ${formatDate(expiresAt.toISOString())}.`,
    `Your quote includes ${delivery.revisions_included} revision${delivery.revisions_included === 1 ? '' : 's'}; ${remaining} remaining. Use the "Request a revision" button on the page, or reply to this email, if you would like a change.`,
    '',
    quoteRow.terms ? `Terms: ${quoteRow.terms}` : null,
    quoteRow.amount_cents ? `Paid: ${money(quoteRow.amount_cents, quoteRow.currency)}` : null,
    '',
    'If anything is hard to open, reply and I will help.',
    '',
    config.company_name || sender.from_name || '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');

  // Store the link on the delivery before the send, so a crash between the
  // provider call and the status update is recoverable.
  await ctx.admin
    .from('deliverables')
    .update({ artifact_url: url })
    .eq('id', delivery.id)
    .eq('owner_id', ownerId);

  let messageId = previous?.id ?? '';
  if (messageId) {
    const { error: updateError } = await ctx.admin
      .from('outreach_messages')
      .update({
        to_email: accountEmail,
        to_name: accountName || null,
        subject,
        body,
        status: 'approved',
        failed_reason: null,
        approved_at: new Date().toISOString(),
      })
      .eq('id', messageId)
      .eq('owner_id', ownerId)
      .in('status', ['failed', 'cancelled']);
    if (updateError) throw new Error(`Could not prepare the delivery email: ${updateError.message}`);
  } else {
    const { data: inserted, error: insertError } = await ctx.admin
      .from('outreach_messages')
      .insert({
        owner_id: ownerId,
        lead_id: delivery.lead_id,
        contact_id: contact.id,
        to_email: accountEmail,
        to_name: accountName || null,
        subject,
        body,
        status: 'approved',
        idempotency_key: key,
        approved_at: new Date().toISOString(),
      })
      .select('id')
      .single();

    if (insertError) throw new Error(`Could not store the delivery email: ${insertError.message}`);
    messageId = inserted.id;
  }

  const { data: claimed, error: claimError } = await ctx.admin.rpc('claim_outreach_message', {
    p_message_id: messageId,
    p_worker_id: `delivery-${ctx.job.id}`,
  });
  if (claimError) throw new Error(`Could not claim the delivery email: ${claimError.message}`);

  const claimedRow = (Array.isArray(claimed) ? claimed[0] : claimed) as { id?: string } | null;
  if (!claimedRow?.id) {
    return {
      skipped: true,
      reason: 'claim_lost',
      messageId,
      hint: 'Another worker owns this send; the retry will record the result.',
    };
  }

  try {
    const result = await sendEmail({
      inboxId: sender.inbox_id,
      to: accountEmail,
      subject,
      text: body,
      replyTo: sender.reply_to ?? null,
    });

    await ctx.admin.rpc('mark_outreach_sent', {
      p_id: messageId,
      p_provider_message_id: result.providerMessageId,
      p_provider_thread_id: result.providerThreadId,
    });

    await finishDelivery(ctx, delivery, messageId, job.id, url);

    await ctx.log('info', `Delivery email sent to ${accountEmail}.`, {
      deliverableId: delivery.id,
      messageId,
      providerMessageId: result.providerMessageId,
    });

    return {
      sent: true,
      messageId,
      deliverableId: delivery.id,
      providerMessageId: result.providerMessageId,
      expiresAt: expiresAt.toISOString(),
    };
  } catch (error) {
    const reason =
      error instanceof ProviderNotConfigured
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    await ctx.admin.rpc('mark_outreach_failed', { p_id: messageId, p_reason: reason });
    await ctx.log('error', `Delivery send failed: ${reason}`, { deliverableId: delivery.id });
    throw error;
  }
};

async function finishDelivery(
  ctx: JobContext,
  delivery: DeliverableRow,
  messageId: string,
  jobId: string,
  url: string,
): Promise<void> {
  if (!url) throw new Error('The delivery has no stored link to record.');

  const { data: updated, error } = await ctx.admin
    .from('deliverables')
    .update({
      status: 'delivered',
      artifact_url: url,
      delivered_at: new Date().toISOString(),
      revision_note: null,
      delivery_message_id: messageId,
    })
    .eq('id', delivery.id)
    .eq('owner_id', delivery.owner_id)
    .in('status', ['pending', 'in_progress', 'revision_requested'])
    .select('id');

  if (error) throw new Error(`Could not mark the delivery delivered: ${error.message}`);
  if (!updated || updated.length === 0) {
    throw new Error('The delivery changed while it was being sent; it was not marked delivered.');
  }

  await ctx.admin
    .from('production_jobs')
    .update({ status: 'delivered', deliverable_id: delivery.id })
    .eq('id', jobId)
    .eq('owner_id', delivery.owner_id);

  await ctx.admin.from('agent_events').insert({
    owner_id: delivery.owner_id,
    job_id: ctx.job.id,
    kind: 'relay.send_delivery',
    level: 'info',
    message: `Delivered "${delivery.title}" to the customer.`,
    data: { deliverableId: delivery.id, messageId },
  });
}
