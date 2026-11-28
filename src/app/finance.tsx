import React, { useState } from 'react';
import { Pressable, Share, View } from 'react-native';
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
  EXPENSE_CATEGORY_LABEL,
  ORDER_STATUS_LABEL,
  PAYMENT_STATUS_LABEL,
  type CloudPaymentIntent,
  type ExpenseCategory,
} from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, radius, spacing } from '@/theme';

/**
 * Finance.
 *
 * Every number comes from a stored row: a verified Stripe payment, a refund the
 * provider reported, or an expense the owner entered. Pending money is shown as
 * pending, and profit subtracts real costs — nothing is estimated.
 */

function money(cents: number, currency = 'usd'): string {
  const symbol = currency.toLowerCase() === 'usd' ? '$' : `${currency.toUpperCase()} `;
  const negative = cents < 0;
  const value = Math.abs(cents) / 100;
  return `${negative ? '-' : ''}${symbol}${value.toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

function relativeFromIso(iso: string | null): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatRelative(parsed) : 'unknown';
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ width: '48%', paddingVertical: spacing.sm }}>
      <AppText variant="micro" style={{ letterSpacing: 1, color: colors.textMuted }}>
        {label}
      </AppText>
      <AppText variant="title" style={{ fontSize: 21, marginTop: 2, color: tone ?? colors.text }}>
        {value}
      </AppText>
    </View>
  );
}

function total(intent: CloudPaymentIntent): number {
  return Math.max(0, intent.amount_cents - intent.refunded_cents);
}

export default function FinanceScreen() {
  const cloud = useCloud();
  const router = useRouter();

  const [note, setNote] = useState('');
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState<ExpenseCategory>('software');

  const finance = cloud.finance;
  const paymentsLive = finance?.paymentsLive ?? cloud.health?.settings?.payments_live ?? false;
  const liveMode = finance?.stripeLiveMode ?? false;

  const submitExpense = async () => {
    const value = Number.parseFloat(amount);
    if (!note.trim() || !Number.isFinite(value) || value <= 0) return;

    const result = await cloud.addExpense({
      category,
      note,
      amountCents: Math.round(value * 100),
    });

    if (result.ok) {
      setNote('');
      setAmount('');
    }
  };

  if (!cloud.session) {
    return (
      <Screen eyebrow="Nova OS" title="Finance" subtitle="Verified revenue, costs and profit.">
        <Panel accent={colors.amber}>
          <EmptyState
            icon="lock-closed-outline"
            title="Sign in to the cloud"
            body="Money records live in the cloud. Sign in on the Cloud screen to see them."
            actionLabel="Open cloud"
            onAction={() => router.push('/cloud')}
          />
        </Panel>
      </Screen>
    );
  }

  const canSubmit = note.trim().length > 0 && Number.parseFloat(amount) > 0;

  return (
    <Screen eyebrow="Nova OS" title="Finance" subtitle="Only verified payments count as revenue.">
      <FadeInView>
        <Panel accent={paymentsLive ? colors.success : colors.amber}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={paymentsLive ? colors.success : colors.amber} size={7} />
            <AppText variant="heading">
              {paymentsLive ? 'PAYMENTS ON' : 'PAYMENTS OFF'}
            </AppText>
          </View>
          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {liveMode
              ? 'Live mode is on. A real card can be charged, and only Stripe’s signed webhook creates the order.'
              : 'Test mode. Stripe test cards only — no real money can move. Live mode stays off until you turn it on after a passing test run.'}
          </AppText>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <View style={{ flex: 1 }}>
              <NeonButton
                label={paymentsLive ? 'Switch off' : 'Switch on'}
                icon={paymentsLive ? 'lock-closed-outline' : 'lock-open-outline'}
                variant="ghost"
                onPress={() => void cloud.updateSettings({ payments_live: !paymentsLive })}
                loading={cloud.busy === 'settings'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <NeonButton
                label={liveMode ? 'Live mode off' : 'Live mode on'}
                icon={liveMode ? 'flask-outline' : 'flash-outline'}
                variant="ghost"
                onPress={() => void cloud.updateSettings({ stripe_live_mode: !liveMode })}
                loading={cloud.busy === 'settings'}
                disabled={!paymentsLive}
              />
            </View>
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={30} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Money" />
        <Panel>
          {!finance ? (
            <AppText variant="caption">
              No finance summary yet. It appears once the cloud answers, and it is computed from stored
              rows only.
            </AppText>
          ) : (
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between' }}>
              <Stat
                label="GROSS REVENUE"
                value={money(finance.grossRevenueCents)}
                tone={colors.success}
              />
              <Stat label="NET REVENUE" value={money(finance.netRevenueCents)} />
              <Stat label="PENDING" value={money(finance.pendingCents)} tone={colors.amber} />
              <Stat label="REFUNDED" value={money(finance.refundedCents)} tone={colors.textDim} />
              <Stat label="EXPENSES" value={money(finance.expensesCents)} />
              <Stat label="AI SPEND" value={money(finance.aiSpendCents)} />
              <Stat
                label="PROFIT"
                value={money(finance.profitCents)}
                tone={finance.profitCents >= 0 ? colors.success : colors.danger}
              />
              <Stat label="PAID ORDERS" value={String(finance.orderCount)} />
            </View>
          )}
          {finance ? (
            <AppText variant="micro" style={{ marginTop: spacing.sm, color: colors.textDim }}>
              {`${finance.paidCount} PAID · ${finance.pendingCount} PENDING · ${finance.failedCount} FAILED OR CANCELLED`}
            </AppText>
          ) : null}
        </Panel>
      </FadeInView>

      <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Payment records · ${cloud.paymentIntents.length}`} />
        <Panel padded={false}>
          {cloud.paymentIntents.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">
                No payment record. One is created from an accepted quote, and only a Stripe webhook can
                mark it paid.
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
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }}>
                    {money(intent.amount_cents, intent.currency)}
                    {intent.refunded_cents > 0 ? `  ·  ${money(intent.refunded_cents)} refunded` : ''}
                  </AppText>
                  <AppText
                    variant="micro"
                    style={{
                      color:
                        intent.status === 'succeeded'
                          ? colors.success
                          : intent.status === 'failed' || intent.status === 'cancelled'
                            ? colors.danger
                            : colors.amber,
                    }}
                  >
                    {PAYMENT_STATUS_LABEL[intent.status]}
                  </AppText>
                </View>
                <AppText variant="micro" style={{ letterSpacing: 0.4, color: colors.textDim }}>
                  {`${intent.provider.toUpperCase()} · CREATED ${relativeFromIso(intent.created_at)}${
                    intent.paid_at ? ` · PAID ${relativeFromIso(intent.paid_at)}` : ''
                  }`}
                </AppText>
                {intent.checkout_url && intent.status === 'checkout_created' ? (
                  <Pressable
                    onPress={() =>
                      void Share.share({ message: intent.checkout_url as string })
                    }
                    style={{ alignSelf: 'flex-start' }}
                  >
                    <AppText variant="micro" style={{ color: colors.violetBright }}>
                      SHARE CHECKOUT
                    </AppText>
                  </Pressable>
                ) : null}
              </View>
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={90} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Paid orders · ${cloud.orders.length}`} />
        <Panel padded={false}>
          {cloud.orders.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">
                An order exists only after Stripe confirms the money. Nothing here is a promise to pay.
              </AppText>
            </View>
          ) : (
            cloud.orders.map((order) => (
              <View
                key={order.id}
                style={{
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  borderTopWidth: 1,
                  borderTopColor: colors.hairline,
                  gap: 4,
                }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }}>
                    {money(order.amount_cents, order.currency)}
                  </AppText>
                  <AppText variant="micro" style={{ color: colors.success }}>
                    {ORDER_STATUS_LABEL[order.status]}
                  </AppText>
                </View>
                <AppText variant="micro" style={{ letterSpacing: 0.4, color: colors.textDim }}>
                  {`PAID ${relativeFromIso(order.paid_at)} · ${order.id.slice(0, 8).toUpperCase()}`}
                </AppText>
              </View>
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Record an expense" />
        <Panel style={{ gap: spacing.md }}>
          <AppText variant="caption">
            Real costs only. The owner types them; NOVA never estimates an expense.
          </AppText>

          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
            {(Object.keys(EXPENSE_CATEGORY_LABEL) as ExpenseCategory[]).map((key) => (
              <Chip
                key={key}
                label={EXPENSE_CATEGORY_LABEL[key]}
                color={category === key ? colors.cyan : colors.textDim}
                active={category === key}
                onPress={() => setCategory(key)}
              />
            ))}
          </View>

          <FormField
            label="What it was"
            placeholder="Stripe fees, design tool, ad spend…"
            value={note}
            onChangeText={setNote}
            maxLength={200}
          />

          <FormField
            label="Amount (USD)"
            placeholder="20"
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            maxLength={9}
          />

          <NeonButton
            label="Record expense"
            icon="receipt-outline"
            onPress={() => void submitExpense()}
            loading={cloud.busy === 'finance'}
            disabled={!canSubmit}
          />
        </Panel>
      </FadeInView>

      <FadeInView delay={150} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Expenses · ${cloud.expenses.length}`} />
        <Panel padded={false}>
          {cloud.expenses.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">Nothing recorded. Profit is revenue minus these costs.</AppText>
            </View>
          ) : (
            cloud.expenses.map((expense) => (
              <View
                key={expense.id}
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
                    {expense.note}
                  </AppText>
                  <AppText variant="micro" style={{ color: colors.textDim }}>
                    {money(expense.amount_cents)}
                  </AppText>
                </View>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <AppText
                    variant="micro"
                    style={{ letterSpacing: 0.4, color: colors.textDim, flex: 1 }}
                  >
                    {`${EXPENSE_CATEGORY_LABEL[expense.category]} · ${expense.incurred_on}`}
                  </AppText>
                  <Pressable onPress={() => void cloud.removeExpense(expense.id)}>
                    <AppText variant="micro" style={{ color: colors.danger }}>
                      REMOVE
                    </AppText>
                  </Pressable>
                </View>
              </View>
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={180} style={{ marginTop: spacing.xxl }}>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <View style={{ flex: 1 }}>
            <NeonButton
              label="Quotes"
              icon="document-text-outline"
              variant="ghost"
              onPress={() => router.push('/quotes')}
            />
          </View>
          <View style={{ flex: 1 }}>
            <NeonButton
              label="Delivery"
              icon="cube-outline"
              variant="ghost"
              onPress={() => router.push('/delivery')}
            />
          </View>
        </View>
        <AppText variant="micro" style={{ marginTop: spacing.md, color: colors.textDim, lineHeight: 16 }}>
          Payments are verified only by Stripe's signed webhook. Screenshots, emails and model output
          are never treated as proof of payment.
        </AppText>
      </FadeInView>
    </Screen>
  );
}
