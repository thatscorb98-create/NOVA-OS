import { buildDraft, sendBlockedReason } from '../compliance.ts';
import type { JobContext, JobHandler } from '../jobs.ts';
import { emailProviderStatus, ProviderNotConfigured, sendEmail } from '../providers/agentmail.ts';

/**
 * Phase 3 handlers.
 *
 *   echo.draft_email → build one draft from stored facts (no model, no invention)
 *   relay.send_email → send an approved draft, if and only if every gate holds
 *
 * Both fail closed. A disabled toggle, a paused company, a suppressed address, a
 * missing provider key or a reached cap produces an explicit error and a stored
 * reason — never a message that claims to have been delivered.
 */

interface SettingsRow {
  autonomy_mode: string;
  email_enabled: boolean;
  daily_email_cap: number;
  company_name: string;
}

interface LeadRow {
  id: string;
  business_name: string;
  website: string | null;
  location: string | null;
  status: string;
  score: number | null;
  score_breakdown: Record<string, unknown> | null;
  recommended_service_key: string | null;
  recommended_service: string | null;
}

interface ContactRow {
  id: string;
  name: string | null;
  email: string;
  email_normalized: string | null;
  opted_out: boolean;
}

async function loadSettings(ctx: JobContext): Promise<SettingsRow> {
  const { data, error } = await ctx.admin
    .from('business_settings')
    .select('autonomy_mode, email_enabled, daily_email_cap, company_name')
    .eq('owner_id', ctx.job.owner_id)
    .maybeSingle();

  if (error) throw new Error(`Could not read business settings: ${error.message}`);
  if (!data) throw new Error('No business settings exist for this owner yet.');

  return data as SettingsRow;
}

function reasonsFrom(breakdown: Record<string, unknown> | null): string[] {
  if (!breakdown) return [];
  const raw = (breakdown as { reasons?: unknown }).reasons;
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === 'string') : [];
}

export const echoDraftEmail: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const settings = await loadSettings(ctx);

  if (settings.autonomy_mode === 'paused') {
    throw new Error('The company is paused, so no draft was written.');
  }

  const leadId = typeof ctx.job.payload.leadId === 'string' ? ctx.job.payload.leadId : '';
  if (!leadId) throw new Error('echo.draft_email needs a leadId.');

  const { data: lead, error: leadError } = await ctx.admin
    .from('leads')
    .select(
      'id, business_name, website, location, status, score, score_breakdown, recommended_service_key, recommended_service',
    )
    .eq('id', leadId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (leadError) throw new Error(`Could not load the lead: ${leadError.message}`);
  if (!lead) throw new Error('That lead no longer exists for this owner.');

  const row = lead as LeadRow;
  if (row.status !== 'qualified' && row.status !== 'researched') {
    throw new Error(`Lead status is "${row.status}"; only a researched or qualified lead can be drafted for.`);
  }

  // Prefer the contact explicitly asked for, otherwise the first real address.
  const requestedContactId =
    typeof ctx.job.payload.contactId === 'string' ? ctx.job.payload.contactId : null;

  let contactQuery = ctx.admin
    .from('contacts')
    .select('id, name, email, email_normalized, opted_out')
    .eq('owner_id', ownerId)
    .eq('lead_id', leadId)
    .eq('opted_out', false)
    .order('created_at', { ascending: true })
    .limit(1);

  if (requestedContactId) {
    contactQuery = ctx.admin
      .from('contacts')
      .select('id, name, email, email_normalized, opted_out')
      .eq('owner_id', ownerId)
      .eq('lead_id', leadId)
      .eq('id', requestedContactId)
      .limit(1);
  }

  const { data: contacts, error: contactError } = await contactQuery;
  if (contactError) throw new Error(`Could not load contacts: ${contactError.message}`);

  const contact = (contacts ?? [])[0] as ContactRow | undefined;
  if (!contact) {
    throw new Error('This lead has no public contact address yet, so there is nobody to write to.');
  }

  const normalized = (contact.email_normalized ?? contact.email).toLowerCase().trim();

  const { data: suppressed, error: suppressionError } = await ctx.admin.rpc('is_email_suppressed', {
    p_owner: ownerId,
    p_email: normalized,
  });
  if (suppressionError) throw new Error(`Could not check suppression: ${suppressionError.message}`);
  if (suppressed === true) {
    throw new Error('That address is on the suppression list, so no draft was written.');
  }

  const { data: openMessages, error: openError } = await ctx.admin
    .from('outreach_messages')
    .select('id, status')
    .eq('owner_id', ownerId)
    .eq('lead_id', leadId)
    .in('status', ['draft', 'approved', 'sending'])
    .limit(1);

  if (openError) throw new Error(`Could not check open messages: ${openError.message}`);
  if ((openMessages ?? []).length > 0) {
    return { skipped: true, reason: 'open_message_exists' };
  }

  let priceCents: number | null = null;
  let deliveryDays = 7;
  let serviceName = row.recommended_service;

  if (row.recommended_service_key) {
    const { data: service } = await ctx.admin
      .from('service_catalog')
      .select('name, price_cents, delivery_days, enabled')
      .eq('owner_id', ownerId)
      .eq('key', row.recommended_service_key)
      .maybeSingle();

    if (service) {
      serviceName = (service.name as string) ?? serviceName;
      deliveryDays = (service.delivery_days as number) ?? 7;
      priceCents = (service.price_cents as number | null) ?? null;
    }
  }

  const draft = buildDraft({
    businessName: row.business_name,
    contactName: contact.name,
    companyName: settings.company_name,
    serviceName,
    priceCents,
    deliveryDays,
    observed: reasonsFrom(row.score_breakdown),
    website: row.website,
  });

  const { data: inserted, error: insertError } = await ctx.admin
    .from('outreach_messages')
    .insert({
      owner_id: ownerId,
      lead_id: leadId,
      contact_id: contact.id,
      to_email: normalized,
      to_name: contact.name,
      subject: draft.subject,
      body: draft.body,
      status: 'draft',
      idempotency_key: `draft:${leadId}:${contact.id}`,
    })
    .select('id, subject')
    .single();

  if (insertError) {
    if (insertError.code === '23505') return { skipped: true, reason: 'draft_exists' };
    throw new Error(`Could not store the draft: ${insertError.message}`);
  }

  await ctx.log('info', `Draft prepared for ${row.business_name} (not sent).`, {
    leadId,
    messageId: inserted.id,
  });

  return { messageId: inserted.id, subject: inserted.subject, status: 'draft', sent: false };
};

export const relaySendEmail: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const messageId = typeof ctx.job.payload.messageId === 'string' ? ctx.job.payload.messageId : '';
  if (!messageId) throw new Error('relay.send_email needs a messageId.');

  const settings = await loadSettings(ctx);

  const { data: message, error: messageError } = await ctx.admin
    .from('outreach_messages')
    .select('id, status, to_email, subject, body, lead_id')
    .eq('id', messageId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (messageError) throw new Error(`Could not load the message: ${messageError.message}`);
  if (!message) throw new Error('That message no longer exists for this owner.');

  if (message.status === 'sent') {
    return { skipped: true, reason: 'already_sent' };
  }
  if (message.status !== 'approved') {
    throw new Error(`Message status is "${message.status}"; only an approved draft can be sent.`);
  }

  const { data: account, error: accountError } = await ctx.admin
    .from('email_accounts')
    .select('from_name, from_email, reply_to, inbox_id, verified, enabled')
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (accountError) throw new Error(`Could not read the sending account: ${accountError.message}`);

  const startOfDay = new Date();
  startOfDay.setUTCHours(0, 0, 0, 0);

  const { count: sentToday } = await ctx.admin
    .from('outreach_messages')
    .select('id', { count: 'exact', head: true })
    .eq('owner_id', ownerId)
    .eq('status', 'sent')
    .gte('sent_at', startOfDay.toISOString());

  const { data: suppressed } = await ctx.admin.rpc('is_email_suppressed', {
    p_owner: ownerId,
    p_email: message.to_email,
  });

  const provider = emailProviderStatus();

  const blocked = sendBlockedReason({
    emailEnabled: settings.email_enabled,
    autonomyMode: settings.autonomy_mode,
    accountEnabled: Boolean(account?.enabled),
    accountVerified: Boolean(account?.verified),
    suppressed: suppressed === true,
    sentToday: sentToday ?? 0,
    dailyCap: settings.daily_email_cap,
    providerConfigured: provider.configured,
  });

  if (blocked) {
    // A gate is not a delivery attempt: the message stays approved and no attempt
    // is consumed, so it can go out once the owner fixes the blocker.
    await ctx.log('warn', `Send blocked: ${blocked}`, { messageId });
    throw new Error(blocked);
  }

  if (!account?.inbox_id) {
    throw new Error('The sending account has no inbox id, so AgentMail cannot be addressed.');
  }

  const { data: claimed, error: claimError } = await ctx.admin.rpc('claim_outreach_message', {
    p_message_id: messageId,
    p_worker_id: `outreach-${ctx.job.id}`,
  });

  if (claimError) throw new Error(`Could not claim the message: ${claimError.message}`);

  const claimedRow = (Array.isArray(claimed) ? claimed[0] : claimed) as { id?: string } | null;
  if (!claimedRow?.id) return { skipped: true, reason: 'claim_lost' };

  try {
    const result = await sendEmail({
      inboxId: account.inbox_id,
      to: message.to_email,
      subject: message.subject,
      text: message.body,
      replyTo: account.reply_to ?? null,
    });

    await ctx.admin.rpc('mark_outreach_sent', {
      p_id: messageId,
      p_provider_message_id: result.providerMessageId,
      p_provider_thread_id: result.providerThreadId,
    });

    await ctx.admin.from('agent_events').insert({
      owner_id: ownerId,
      job_id: ctx.job.id,
      kind: 'relay.send_email',
      level: 'info',
      message: `Email sent to ${message.to_email}.`,
      data: { messageId, providerMessageId: result.providerMessageId },
    });

    if (message.lead_id) {
      await ctx.admin
        .from('deals')
        .update({ stage: 'contacted', next_action: 'Wait for a reply, then follow up once.' })
        .eq('owner_id', ownerId)
        .eq('lead_id', message.lead_id)
        .in('stage', ['qualified', 'researched']);
    }

    return { sent: true, messageId, providerMessageId: result.providerMessageId };
  } catch (error) {
    const reason =
      error instanceof ProviderNotConfigured
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);

    await ctx.admin.rpc('mark_outreach_failed', { p_id: messageId, p_reason: reason });
    await ctx.log('error', `Send failed: ${reason}`, { messageId });
    throw error;
  }
};
