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

interface FollowUpRow {
  id: string;
  message_id: string;
  lead_id: string | null;
  contact_id: string | null;
  kind: string;
  status: string;
  due_at: string;
  note: string | null;
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

  const { data: blockedDeal } = await ctx.admin
    .from('deals')
    .select('stage')
    .eq('owner_id', ownerId)
    .eq('lead_id', leadId)
    .maybeSingle();

  if (blockedDeal?.stage === 'do_not_contact') {
    throw new Error('That lead is marked do not contact, so no draft was written.');
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

export const echoDraftFollowUp: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const followUpId =
    typeof ctx.job.payload.followUpId === 'string' ? ctx.job.payload.followUpId : '';
  if (!followUpId) throw new Error('echo.draft_follow_up needs a followUpId.');

  const { data: followUpData, error: followUpError } = await ctx.admin
    .from('follow_ups')
    .select('id, message_id, lead_id, contact_id, kind, status, due_at, note')
    .eq('id', followUpId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (followUpError) throw new Error(`Could not load the follow-up: ${followUpError.message}`);
  const followUp = followUpData as FollowUpRow | null;
  if (!followUp) throw new Error('That follow-up no longer exists for this owner.');
  if (followUp.status !== 'scheduled') return { skipped: true, reason: followUp.status };

  if (Date.parse(followUp.due_at) > Date.now()) {
    throw new Error('This follow-up is not due yet.');
  }

  const { data: originalData, error: originalError } = await ctx.admin
    .from('outreach_messages')
    .select('id, status, to_email, to_name, subject, lead_id')
    .eq('id', followUp.message_id)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (originalError) throw new Error(`Could not load the original message: ${originalError.message}`);
  const original = originalData as {
    id: string;
    status: string;
    to_email: string;
    to_name: string | null;
    subject: string;
    lead_id: string | null;
  } | null;

  if (!original) throw new Error('The original message no longer exists.');
  if (original.status !== 'sent') {
    throw new Error(`The original message is "${original.status}", so no follow-up is written.`);
  }

  const { data: suppressed, error: suppressionError } = await ctx.admin.rpc('is_email_suppressed', {
    p_owner: ownerId,
    p_email: original.to_email,
  });
  if (suppressionError) throw new Error(`Could not check suppression: ${suppressionError.message}`);
  if (suppressed === true) {
    throw new Error('That address is suppressed, so no follow-up is written.');
  }

  const settings = await loadSettings(ctx);
  if (settings.autonomy_mode === 'paused') {
    throw new Error('The company is paused, so no follow-up draft was written.');
  }

  // A contact or lead preference can change between scheduling and drafting.
  const { data: optedOut } = await ctx.admin
    .from('contacts')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('email_normalized', original.to_email.trim().toLowerCase())
    .eq('opted_out', true)
    .limit(1)
    .maybeSingle();

  if (optedOut) {
    throw new Error('That contact has opted out, so no follow-up is written.');
  }

  let businessName = '';
  if (followUp.lead_id) {
    const { data: lead } = await ctx.admin
      .from('leads')
      .select('business_name, status')
      .eq('id', followUp.lead_id)
      .eq('owner_id', ownerId)
      .maybeSingle();

    const { data: deal } = await ctx.admin
      .from('deals')
      .select('stage')
      .eq('owner_id', ownerId)
      .eq('lead_id', followUp.lead_id)
      .maybeSingle();

    if (lead?.status === 'do_not_contact' || deal?.stage === 'do_not_contact') {
      throw new Error('That lead is marked do not contact, so no follow-up is written.');
    }

    businessName = (lead?.business_name as string | undefined) ?? '';
  }

  let deliveredTitle = '';
  if (followUp.kind === 'recurring' || followUp.kind === 'receipt') {
    const { data: delivered } = await ctx.admin
      .from('deliverables')
      .select('title')
      .eq('owner_id', ownerId)
      .eq('delivery_message_id', original.id)
      .maybeSingle();
    deliveredTitle = (delivered?.title as string | undefined) ?? '';
  }

  const first = original.to_name ? original.to_name.trim().split(/\s+/)[0] : null;
  const greeting = first && first.length >= 2 ? first : 'there';
  const subject = (original.subject.toLowerCase().startsWith('re:')
    ? original.subject
    : `Re: ${original.subject}`
  ).slice(0, 160);

  const subjectLine = deliveredTitle || businessName || 'the work';

  const kindLine =
    followUp.kind === 'receipt'
      ? `I wanted to check that everything in ${subjectLine} opened correctly for you. If a file will not open or something looks wrong, reply and I will fix it.`
      : followUp.kind === 'review'
        ? `I hope ${subjectLine} is working well. If you have a moment, a short honest review would help other small businesses decide whether this is right for them. No pressure, and no incentive — just your own words.`
        : followUp.kind === 'recurring'
          ? `${subjectLine} has been live for a while. If you would like it refreshed for the season or updated with new offers, I can put that together. I will not assume a schedule or a price — tell me what you need and I will quote it before anything starts.`
          : businessName
            ? `Just following up on my note about ${businessName}. If it would help, I can send the details and you can decide from there.`
            : 'Just following up on my note. If it would help, I can send the details and you can decide from there.';

  const body = [
    `Hi ${greeting},`,
    '',
    kindLine,
    '',
    ...(followUp.kind === 'receipt'
      ? ['Thanks,', settings.company_name]
      : [
          'If now is not the time, just reply "not now" and I will close the loop.',
          '',
          'Thanks,',
          settings.company_name,
        ]),
    '',
    'If you would rather not hear from me, reply "unsubscribe" and I will remove this address.',
  ].join('\n');

  const { data: inserted, error: insertError } = await ctx.admin
    .from('outreach_messages')
    .insert({
      owner_id: ownerId,
      lead_id: original.lead_id,
      contact_id: followUp.contact_id,
      to_email: original.to_email,
      to_name: original.to_name,
      subject,
      body,
      status: 'draft',
      idempotency_key: `followup:${followUpId}`,
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === '23505') return { skipped: true, reason: 'follow_up_draft_exists' };
    throw new Error(`Could not store the follow-up draft: ${insertError.message}`);
  }

  await ctx.admin.rpc('mark_follow_up_drafted', {
    p_id: followUpId,
    p_draft_message_id: inserted.id,
  });

  await ctx.log('info', `Follow-up draft prepared for ${original.to_email} (not sent).`, {
    followUpId,
    messageId: inserted.id,
    kind: followUp.kind,
  });

  return { followUpId, messageId: inserted.id, kind: followUp.kind, status: 'draft', sent: false };
};

interface ReplyEventRow {
  id: number;
  message_id: string | null;
  kind: string;
  intent: string | null;
  detail: string | null;
}

/**
 * CLOSER's routine reply draft.
 *
 * A reply draft is built from the stored reply label and the lead's own facts,
 * never from instructions inside the reply. It is a draft: the owner approves
 * it, and every send still passes the same gates as any other email. An opt-out
 * or suppression ends the conversation instead of drafting a reply.
 */
export const closerDraftReply: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const eventId = Number(ctx.job.payload.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) {
    throw new Error('closer.draft_reply needs an eventId.');
  }

  const { data: eventData, error: eventError } = await ctx.admin
    .from('email_events')
    .select('id, message_id, kind, intent, detail')
    .eq('id', eventId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (eventError) throw new Error(`Could not load the reply: ${eventError.message}`);
  const event = eventData as ReplyEventRow | null;
  if (!event) throw new Error('That reply no longer exists for this owner.');
  if (event.kind !== 'replied') throw new Error('That event is not a reply.');
  if (!event.message_id) throw new Error('The reply is not attached to a message.');
  if (event.intent === 'unsubscribe') {
    throw new Error('The customer opted out; no reply is drafted.');
  }

  const { data: originalData, error: originalError } = await ctx.admin
    .from('outreach_messages')
    .select('id, to_email, to_name, subject, lead_id, contact_id')
    .eq('id', event.message_id)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (originalError) throw new Error(`Could not load the message: ${originalError.message}`);
  const original = originalData as {
    id: string;
    to_email: string;
    to_name: string | null;
    subject: string;
    lead_id: string | null;
    contact_id: string | null;
  } | null;

  if (!original) throw new Error('The original message no longer exists.');

  const { data: suppressed } = await ctx.admin.rpc('is_email_suppressed', {
    p_owner: ownerId,
    p_email: original.to_email,
  });
  if (suppressed === true) {
    throw new Error('That address is suppressed, so no reply is drafted.');
  }

  const { data: openMessages } = await ctx.admin
    .from('outreach_messages')
    .select('id')
    .eq('owner_id', ownerId)
    .eq('to_email', original.to_email)
    .in('status', ['draft', 'approved', 'sending'])
    .limit(1);

  if ((openMessages ?? []).length > 0) {
    return { skipped: true, reason: 'open_message_exists' };
  }

  const settings = await loadSettings(ctx);
  if (settings.autonomy_mode === 'paused') {
    throw new Error('The company is paused, so no reply was drafted.');
  }

  let businessName = '';
  if (original.lead_id) {
    const { data: lead } = await ctx.admin
      .from('leads')
      .select('business_name')
      .eq('id', original.lead_id)
      .eq('owner_id', ownerId)
      .maybeSingle();
    businessName = (lead?.business_name as string | undefined) ?? '';
  }

  const first = original.to_name ? original.to_name.trim().split(/\s+/)[0] : null;
  const greeting = first && first.length >= 2 ? first : 'there';
  const intent = event.intent ?? 'other';

  const intentLine =
    intent === 'not_interested'
      ? 'Thanks for letting me know. I will close the loop and will not follow up again.'
      : intent === 'interested' || intent === 'question'
        ? businessName
          ? `Thanks for getting back to me about ${businessName}. I can set out the scope, price and timing in writing so you can decide without pressure. What is the best way to reach you?`
          : 'Thanks for getting back to me. I can set out the scope, price and timing in writing so you can decide without pressure. What is the best way to reach you?'
        : 'Thanks for the reply. Tell me what you need and I will answer directly.';

  const body = [
    `Hi ${greeting},`,
    '',
    intentLine,
    '',
    'Thanks,',
    settings.company_name,
    '',
    'If you would rather not hear from me, reply "unsubscribe" and I will remove this address.',
  ].join('\n');

  const subject = (original.subject.toLowerCase().startsWith('re:')
    ? original.subject
    : `Re: ${original.subject}`
  ).slice(0, 160);

  const { data: inserted, error: insertError } = await ctx.admin
    .from('outreach_messages')
    .insert({
      owner_id: ownerId,
      lead_id: original.lead_id,
      contact_id: original.contact_id,
      to_email: original.to_email,
      to_name: original.to_name,
      subject,
      body,
      status: 'draft',
      idempotency_key: `reply:${eventId}`,
    })
    .select('id')
    .single();

  if (insertError) {
    if (insertError.code === '23505') return { skipped: true, reason: 'reply_draft_exists' };
    throw new Error(`Could not store the reply draft: ${insertError.message}`);
  }

  await ctx.log('info', `CLOSER prepared a reply for ${original.to_email} (not sent).`, {
    eventId,
    messageId: inserted.id,
    intent,
  });

  return { eventId, messageId: inserted.id, intent, status: 'draft', sent: false };
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
