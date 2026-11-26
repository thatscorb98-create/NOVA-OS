import type { JobContext, JobHandler } from '../jobs.ts';

/**
 * Phase 4/5 job handlers.
 *
 *   relay.create_payment_intent → records what is owed for an accepted quote
 *   relay.record_payment        → stores a provider's real payment result
 *
 * Neither handler charges anything. `create_payment_intent` only writes an
 * internal row: the database refuses it unless the quote was accepted by the
 * customer and payments are switched live by the owner. With no payment provider
 * connected the row carries `provider = 'none'`, which means "owed, not
 * chargeable" — no money moves and no card details are involved.
 */

interface QuoteRow {
  id: string;
  owner_id: string;
  lead_id: string | null;
  title: string;
  amount_cents: number;
  currency: string;
  status: string;
  expires_at: string | null;
}

function paymentProvider(): { configured: boolean; reason: string } {
  const key = Deno.env.get('STRIPE_SECRET_KEY');
  return key && key.trim().length > 0
    ? { configured: true, reason: 'Stripe is configured.' }
    : {
        configured: false,
        reason: 'No payment provider is connected (STRIPE_SECRET_KEY is not set), so nothing can be collected.',
      };
}

export const relayCreatePaymentIntent: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const quoteId = typeof ctx.job.payload.quoteId === 'string' ? ctx.job.payload.quoteId : '';
  if (!quoteId) throw new Error('relay.create_payment_intent needs a quoteId.');

  const { data: quoteData, error: quoteError } = await ctx.admin
    .from('quotes')
    .select('id, owner_id, lead_id, title, amount_cents, currency, status, expires_at')
    .eq('id', quoteId)
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (quoteError) throw new Error(`Could not load the quote: ${quoteError.message}`);

  const quote = quoteData as QuoteRow | null;
  if (!quote) throw new Error('That quote no longer exists for this owner.');
  if (quote.status !== 'accepted') {
    throw new Error(
      `The quote is "${quote.status}". Payment creation is only permitted after the customer accepts.`,
    );
  }

  const { data: settings, error: settingsError } = await ctx.admin
    .from('business_settings')
    .select('payments_live')
    .eq('owner_id', ownerId)
    .maybeSingle();

  if (settingsError) throw new Error(`Could not read company settings: ${settingsError.message}`);
  if (!settings?.payments_live) {
    throw new Error('Payments are not live for this company, so no payment record was created.');
  }

  const { data, error } = await ctx.admin.rpc('create_payment_intent', { p_quote_id: quoteId });

  if (error) {
    // 23505 = the one-live-intent index already holds this quote. Returning the
    // existing row is success; a retry must not create a second intent.
    if (error.code === '23505') {
      const { data: existing } = await ctx.admin
        .from('payment_intents')
        .select('id, status, amount_cents, currency, provider')
        .eq('quote_id', quoteId)
        .in('status', ['requires_payment', 'pending', 'succeeded'])
        .maybeSingle();

      await ctx.log('info', 'A payment record already exists for this quote; nothing duplicated.', {
        quoteId,
        intentId: existing?.id ?? null,
      });

      return {
        skipped: true,
        reason: 'intent_exists',
        intentId: existing?.id ?? null,
        charged: false,
      };
    }
    throw new Error(`Could not record the payment intent: ${error.message}`);
  }

  const intent = (Array.isArray(data) ? data[0] : data) as
    | { id: string; status: string; amount_cents: number; currency: string; provider: string }
    | null;

  if (!intent?.id) throw new Error('The database returned no payment intent.');

  const provider = paymentProvider();

  await ctx.log(
    provider.configured ? 'info' : 'warn',
    provider.configured
      ? `Payment record ${intent.id} created for ${intent.amount_cents} ${intent.currency}. No charge was attempted.`
      : `Payment record ${intent.id} created (owed, not chargeable). ${provider.reason}`,
    { quoteId, intentId: intent.id, provider: intent.provider },
  );

  return {
    intentId: intent.id,
    status: intent.status,
    amountCents: intent.amount_cents,
    currency: intent.currency,
    provider: intent.provider,
    chargeable: provider.configured && intent.provider !== 'none',
    charged: false,
  };
};

/**
 * Records a payment the provider actually reported. A succeeded status is
 * rejected by the table unless a provider reference is present, so a payment that
 * never happened cannot be stored as one.
 */
export const relayRecordPayment: JobHandler = async (ctx: JobContext) => {
  const ownerId = ctx.job.owner_id;
  const intentId = typeof ctx.job.payload.intentId === 'string' ? ctx.job.payload.intentId : '';
  const status = typeof ctx.job.payload.status === 'string' ? ctx.job.payload.status : '';
  const providerRef =
    typeof ctx.job.payload.providerRef === 'string' ? ctx.job.payload.providerRef.trim() : '';

  if (!intentId) throw new Error('relay.record_payment needs an intentId.');
  if (!['pending', 'succeeded', 'failed', 'cancelled'].includes(status)) {
    throw new Error(`"${status}" is not a payment status this handler records.`);
  }
  if (status === 'succeeded' && !providerRef) {
    throw new Error('A succeeded payment needs the provider reference; none was supplied.');
  }

  const { data, error } = await ctx.admin
    .from('payment_intents')
    .update({
      status,
      provider_ref: providerRef || null,
      provider: providerRef ? 'stripe' : 'none',
    })
    .eq('id', intentId)
    .eq('owner_id', ownerId)
    .select('id, status, amount_cents, currency, provider_ref')
    .maybeSingle();

  if (error) throw new Error(`Could not record the payment: ${error.message}`);
  if (!data) throw new Error('That payment record does not exist for this owner.');

  await ctx.log('info', `Payment ${intentId} recorded as ${status}.`, {
    intentId,
    providerRef: providerRef || null,
  });

  return { intentId, status, providerRef: providerRef || null };
};
