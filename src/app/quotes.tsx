import React, { useMemo, useState } from 'react';
import { Pressable, Share, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusDot } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { FormField } from '@/components/ui/FormField';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Screen } from '@/components/ui/Screen';
import {
  PAYMENT_STATUS_LABEL,
  QUOTE_STATUS_LABEL,
  type CloudQuote,
  type QuoteStatus,
} from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, fonts, radius, spacing } from '@/theme';

/**
 * Quotes.
 *
 * The owner writes the amount, releases the quote, and shares a signed link. The
 * customer accepts on that link, and only then can a payment record be created.
 * Nothing on this screen charges anyone: with no payment provider connected an
 * "owed" record is exactly what it says.
 */

const inputStyle = {
  color: colors.text,
  fontFamily: fonts.body,
  fontSize: 14,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm + 2,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: colors.panelBorder,
  backgroundColor: 'rgba(10, 14, 28, 0.9)',
} as const;

function money(cents: number, currency: string): string {
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `;
  return `${symbol}${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function stageTone(status: QuoteStatus): string {
  switch (status) {
    case 'accepted':
      return colors.success;
    case 'sent':
      return colors.cyan;
    case 'declined':
    case 'expired':
      return colors.textDim;
    default:
      return colors.violetBright;
  }
}

function relativeFromIso(iso: string | null): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatRelative(parsed) : 'unknown';
}

function QuoteRow({
  quote,
  businessName,
  link,
  busy,
  onSend,
  onLink,
  onRecordOwed,
  hasIntent,
}: {
  quote: CloudQuote;
  businessName: string | null;
  link: string | null;
  busy: boolean;
  onSend: () => void;
  onLink: () => void;
  onRecordOwed: () => void;
  hasIntent: boolean;
}) {
  return (
    <View
      style={{
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.hairline,
        gap: spacing.sm,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }} numberOfLines={2}>
          {quote.title}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 }}>
          <StatusDot color={stageTone(quote.status)} size={5} />
          <AppText variant="micro" style={{ color: stageTone(quote.status) }}>
            {QUOTE_STATUS_LABEL[quote.status]}
          </AppText>
        </View>
      </View>

      <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.4 }}>
        {`${businessName ?? 'no lead'} · ${money(quote.amount_cents, quote.currency)} · ${
          quote.delivery_days
        } DAYS`}
      </AppText>

      <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.3, color: colors.textDim }}>
        {`CREATED ${relativeFromIso(quote.created_at)}${
          quote.accepted_at ? ` · ACCEPTED ${relativeFromIso(quote.accepted_at)}` : ''
        }${quote.expires_at ? ` · EXPIRES ${relativeFromIso(quote.expires_at)}` : ''}`}
      </AppText>

      {quote.scope ? (
        <AppText variant="caption" numberOfLines={3}>
          {quote.scope}
        </AppText>
      ) : null}

      {link ? (
        <View
          style={{
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: `${colors.cyan}44`,
            backgroundColor: 'rgba(34, 211, 238, 0.06)',
            padding: spacing.md,
            gap: spacing.sm,
          }}
        >
          <AppText variant="micro" style={{ color: colors.cyan, letterSpacing: 0.6 }}>
            ACCEPTANCE LINK
          </AppText>
          <AppText variant="caption" selectable style={{ lineHeight: 18 }}>
            {link}
          </AppText>
          <Pressable onPress={() => void Share.share({ message: link })} style={{ alignSelf: 'flex-start' }}>
            <AppText variant="micro" style={{ color: colors.violetBright }}>
              SHARE LINK
            </AppText>
          </Pressable>
        </View>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
        {quote.status === 'draft' ? (
          <Pressable
            onPress={onSend}
            disabled={busy}
            style={({ pressed }) => ({
              opacity: busy ? 0.5 : pressed ? 0.7 : 1,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: `${colors.violet}55`,
              backgroundColor: 'rgba(139, 92, 246, 0.12)',
            })}
          >
            <AppText variant="micro" style={{ color: colors.violetBright }}>
              RELEASE QUOTE
            </AppText>
          </Pressable>
        ) : null}

        {quote.status === 'sent' ? (
          <Pressable
            onPress={onLink}
            disabled={busy}
            style={({ pressed }) => ({
              opacity: busy ? 0.5 : pressed ? 0.7 : 1,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: `${colors.cyan}55`,
              backgroundColor: 'rgba(34, 211, 238, 0.10)',
            })}
          >
            <AppText variant="micro" style={{ color: colors.cyan }}>
              {link ? 'RENEW LINK' : 'CREATE LINK'}
            </AppText>
          </Pressable>
        ) : null}

        {quote.status === 'accepted' && !hasIntent ? (
          <Pressable
            onPress={onRecordOwed}
            disabled={busy}
            style={({ pressed }) => ({
              opacity: busy ? 0.5 : pressed ? 0.7 : 1,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: `${colors.success}55`,
              backgroundColor: 'rgba(74, 222, 128, 0.08)',
            })}
          >
            <AppText variant="micro" style={{ color: colors.success }}>
              RECORD AMOUNT OWED
            </AppText>
          </Pressable>
        ) : null}

        {quote.status === 'accepted' && hasIntent ? (
          <AppText variant="micro" style={{ color: colors.success, letterSpacing: 0.4 }}>
            PAYMENT RECORD ON FILE
          </AppText>
        ) : null}
      </View>
    </View>
  );
}

export default function QuotesScreen() {
  const cloud = useCloud();
  const router = useRouter();

  const [leadId, setLeadId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState('');
  const [amount, setAmount] = useState('');
  const [days, setDays] = useState('7');
  const [expiry, setExpiry] = useState('14');
  const [links, setLinks] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const settings = cloud.health?.settings;
  const paymentsLive = settings?.payments_live ?? false;

  const quotableLeads = useMemo(
    () =>
      cloud.leads.filter((lead) => lead.status === 'qualified' || lead.status === 'researched'),
    [cloud.leads],
  );

  const selectedLead = quotableLeads.find((lead) => lead.id === leadId) ?? null;

  const businessName = (id: string | null): string | null => {
    if (!id) return null;
    return cloud.leads.find((lead) => lead.id === id)?.business_name ?? null;
  };

  const open = cloud.quotes.filter((quote) => quote.status === 'draft' || quote.status === 'sent');
  const accepted = cloud.quotes.filter((quote) => quote.status === 'accepted');
  const closed = cloud.quotes.filter(
    (quote) => quote.status === 'declined' || quote.status === 'expired',
  );

  const intentFor = (quoteId: string) =>
    cloud.paymentIntents.find((intent) => intent.quote_id === quoteId) ?? null;

  const pickLead = (id: string) => {
    setLeadId(id);
    const lead = cloud.leads.find((item) => item.id === id);
    if (lead && !title.trim()) {
      setTitle(`${lead.business_name}${lead.recommended_service ? ` — ${lead.recommended_service}` : ''}`);
    }
  };

  const submit = async () => {
    if (!leadId) return;
    const value = Number.parseFloat(amount);
    if (!Number.isFinite(value) || value <= 0) return;
    if (!title.trim()) return;

    const result = await cloud.createQuote({
      leadId,
      title,
      scope,
      amountCents: Math.round(value * 100),
      deliveryDays: Number.parseInt(days, 10) || 7,
      expiresInDays: Number.parseInt(expiry, 10) || 14,
    });

    if (result.ok) {
      setLeadId(null);
      setTitle('');
      setScope('');
      setAmount('');
    }
  };

  const send = async (id: string) => {
    setBusyId(id);
    await cloud.sendQuote(id);
    setBusyId(null);
  };

  const makeLink = async (id: string) => {
    setBusyId(id);
    const result = await cloud.quoteLink(id);
    setBusyId(null);
    if (result.ok && result.detail) {
      setLinks((previous) => ({ ...previous, [id]: result.detail as string }));
    }
  };

  const recordOwed = async (id: string) => {
    setBusyId(id);
    await cloud.recordPaymentDue(id);
    setBusyId(null);
  };

  if (!cloud.session) {
    return (
      <Screen eyebrow="Nova OS" title="Quotes" subtitle="Amounts, acceptance and what is owed.">
        <Panel accent={colors.amber}>
          <EmptyState
            icon="lock-closed-outline"
            title="Sign in to the cloud"
            body="Quotes live in the cloud. Sign in on the Cloud screen to write and release them."
            actionLabel="Open cloud"
            onAction={() => router.push('/cloud')}
          />
        </Panel>
      </Screen>
    );
  }

  const canSubmit = Boolean(leadId) && Number.parseFloat(amount) > 0 && title.trim().length > 0;

  return (
    <Screen eyebrow="Nova OS" title="Quotes" subtitle="The customer accepts; only then is an amount owed.">
      <FadeInView>
        <Panel accent={paymentsLive ? colors.success : colors.amber}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={paymentsLive ? colors.success : colors.amber} size={7} />
            <AppText variant="heading">{paymentsLive ? 'PAYMENTS ON' : 'PAYMENTS OFF'}</AppText>
          </View>
          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {paymentsLive
              ? 'An accepted quote can record the amount owed. No payment provider is connected, so nothing is charged and no card details are collected.'
              : 'Payment records stay blocked until you switch payments on. Even then, nothing charges: no provider is connected.'}
          </AppText>
          <View style={{ marginTop: spacing.md }}>
            <NeonButton
              label={paymentsLive ? 'Switch payments off' : 'Switch payments on'}
              icon={paymentsLive ? 'lock-closed-outline' : 'lock-open-outline'}
              variant="ghost"
              onPress={() => void cloud.updateSettings({ payments_live: !paymentsLive })}
              loading={cloud.busy === 'settings'}
            />
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={30} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="New quote" />
        <Panel style={{ gap: spacing.md }}>
          {quotableLeads.length === 0 ? (
            <AppText variant="caption">
              No researched or qualified lead is on file yet, so there is nothing to quote. Discovery
              and scoring come first.
            </AppText>
          ) : (
            <>
              <AppText variant="micro" style={{ letterSpacing: 1, color: colors.textMuted }}>
                LEAD
              </AppText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {quotableLeads.slice(0, 12).map((lead) => (
                  <Chip
                    key={lead.id}
                    label={lead.business_name}
                    color={lead.id === leadId ? colors.cyan : colors.textDim}
                    active={lead.id === leadId}
                    onPress={() => pickLead(lead.id)}
                  />
                ))}
              </View>

              <FormField
                label="Title"
                placeholder="Website rebuild"
                value={title}
                onChangeText={setTitle}
                maxLength={160}
              />

              <FormField
                label="Scope"
                placeholder="What is included, and what is not."
                value={scope}
                onChangeText={setScope}
                multiline
                maxLength={2000}
              />

              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <FormField
                    label="Amount (USD)"
                    placeholder="1500"
                    value={amount}
                    onChangeText={setAmount}
                    keyboardType="decimal-pad"
                    maxLength={9}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <FormField
                    label="Delivery days"
                    placeholder="7"
                    value={days}
                    onChangeText={setDays}
                    keyboardType="number-pad"
                    maxLength={2}
                  />
                </View>
              </View>

              <FormField
                label="Expires in days"
                placeholder="14"
                value={expiry}
                onChangeText={setExpiry}
                keyboardType="number-pad"
                maxLength={2}
                hint="The acceptance link stops working after this."
              />

              {selectedLead ? (
                <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
                  {`QUOTING ${selectedLead.business_name.toUpperCase()}`}
                </AppText>
              ) : null}

              <NeonButton
                label="Save draft quote"
                icon="document-text-outline"
                onPress={() => void submit()}
                loading={cloud.busy === 'quote'}
                disabled={!canSubmit}
              />
            </>
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Open quotes · ${open.length}`} />
        <Panel padded={false}>
          {open.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">No draft or waiting quote. Write one above.</AppText>
            </View>
          ) : (
            open.map((quote) => (
              <QuoteRow
                key={quote.id}
                quote={quote}
                businessName={businessName(quote.lead_id)}
                link={links[quote.id] ?? null}
                busy={busyId === quote.id || cloud.busy === 'quote'}
                onSend={() => void send(quote.id)}
                onLink={() => void makeLink(quote.id)}
                onRecordOwed={() => void recordOwed(quote.id)}
                hasIntent={intentFor(quote.id) !== null}
              />
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={90} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Accepted · ${accepted.length}`} />
        <Panel padded={false}>
          {accepted.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">
                A quote lands here only when the customer accepts it on its link.
              </AppText>
            </View>
          ) : (
            accepted.map((quote) => (
              <QuoteRow
                key={quote.id}
                quote={quote}
                businessName={businessName(quote.lead_id)}
                link={links[quote.id] ?? null}
                busy={busyId === quote.id || cloud.busy === 'quote'}
                onSend={() => {}}
                onLink={() => void makeLink(quote.id)}
                onRecordOwed={() => void recordOwed(quote.id)}
                hasIntent={intentFor(quote.id) !== null}
              />
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Payment records · ${cloud.paymentIntents.length}`} />
        <Panel padded={false}>
          {cloud.paymentIntents.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">
                Nothing owed yet. A record is created only from an accepted quote, and never claims a
                payment happened.
              </AppText>
            </View>
          ) : (
            cloud.paymentIntents.map((intent) => (
              <View
                key={intent.id}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  borderTopWidth: 1,
                  borderTopColor: colors.hairline,
                  gap: 3,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }}>
                    {money(intent.amount_cents, intent.currency)}
                  </AppText>
                  <AppText
                    variant="micro"
                    style={{
                      color: intent.status === 'succeeded' ? colors.success : colors.cyan,
                    }}
                  >
                    {PAYMENT_STATUS_LABEL[intent.status]}
                  </AppText>
                </View>
                <AppText variant="micro" style={{ letterSpacing: 0.4, color: colors.textDim }}>
                  {`PROVIDER ${intent.provider.toUpperCase()} · CREATED ${relativeFromIso(
                    intent.created_at,
                  )}`}
                </AppText>
              </View>
            ))
          )}
        </Panel>
      </FadeInView>

      {closed.length > 0 ? (
        <FadeInView delay={150} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label={`Closed · ${closed.length}`} />
          <Panel padded={false}>
            {closed.map((quote) => (
              <View
                key={quote.id}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  borderTopWidth: 1,
                  borderTopColor: colors.hairline,
                  gap: 3,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13 }} numberOfLines={1}>
                    {quote.title}
                  </AppText>
                  <AppText variant="micro" style={{ color: stageTone(quote.status) }}>
                    {QUOTE_STATUS_LABEL[quote.status]}
                  </AppText>
                </View>
                <AppText variant="micro" style={{ letterSpacing: 0.4, color: colors.textDim }}>
                  {`${money(quote.amount_cents, quote.currency)} · ${businessName(quote.lead_id) ?? 'no lead'}`}
                </AppText>
              </View>
            ))}
          </Panel>
        </FadeInView>
      ) : null}

      <FadeInView delay={180} style={{ marginTop: spacing.xxl }}>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <NeonButton
              label="Outreach"
              icon="mail-outline"
              variant="ghost"
              onPress={() => router.push('/outreach')}
            />
          </View>
          <View style={{ flex: 1 }}>
            <NeonButton
              label="Pipeline"
              icon="git-branch-outline"
              variant="ghost"
              onPress={() => router.push('/pipeline')}
            />
          </View>
        </View>
      </FadeInView>
    </Screen>
  );
}
