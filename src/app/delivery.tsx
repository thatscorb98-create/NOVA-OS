import React, { useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { StatusDot } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Screen } from '@/components/ui/Screen';
import {
  DELIVERABLE_STATUS_LABEL,
  type CloudDeliverable,
  type CloudQuote,
  type DeliverableStatus,
} from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, fonts, radius, spacing } from '@/theme';

/**
 * Delivery.
 *
 * Work exists only for an accepted quote, and a delivery counts only when there
 * is a link to the actual work. Nothing on this screen writes a price, marks a
 * payment, or invents an artifact: the database refuses all three.
 */

const CLOSED: DeliverableStatus[] = ['accepted', 'cancelled'];

const inputStyle = {
  color: colors.text,
  fontFamily: fonts.body,
  fontSize: 13,
  paddingHorizontal: spacing.md,
  paddingVertical: spacing.sm + 2,
  borderRadius: radius.md,
  borderWidth: 1,
  borderColor: colors.panelBorder,
  backgroundColor: 'rgba(10, 14, 28, 0.9)',
} as const;

function relativeFromIso(iso: string | null): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatRelative(parsed) : 'unknown';
}

function statusTone(status: DeliverableStatus): string {
  switch (status) {
    case 'accepted':
      return colors.success;
    case 'delivered':
      return colors.emerald;
    case 'revision_requested':
      return colors.amber;
    case 'in_progress':
      return colors.cyan;
    case 'cancelled':
      return colors.textDim;
    default:
      return colors.violetBright;
  }
}

function ActionButton({
  label,
  color,
  onPress,
  disabled,
}: {
  label: string;
  color: string;
  onPress: () => void;
  disabled: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: `${color}55`,
        backgroundColor: `${color}12`,
      })}
    >
      <AppText variant="micro" style={{ color }}>
        {label}
      </AppText>
    </Pressable>
  );
}

function DeliverableRow({
  item,
  businessName,
  busy,
  onStart,
  onDeliver,
  onAccept,
  onRevision,
}: {
  item: CloudDeliverable;
  businessName: string | null;
  busy: boolean;
  onStart: () => void;
  onDeliver: (url: string) => void;
  onAccept: () => void;
  onRevision: (note: string) => void;
}) {
  const [mode, setMode] = useState<'none' | 'link' | 'note'>('none');
  const [text, setText] = useState('');

  const revisionsLeft = item.revisions_included - item.revisions_used;
  const canRevise = item.status === 'delivered' && revisionsLeft > 0;
  const canDeliver =
    item.status === 'pending' ||
    item.status === 'in_progress' ||
    item.status === 'revision_requested';

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
        <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }} numberOfLines={1}>
          {item.title}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 }}>
          <StatusDot color={statusTone(item.status)} size={5} />
          <AppText variant="micro" style={{ color: statusTone(item.status) }}>
            {DELIVERABLE_STATUS_LABEL[item.status]}
          </AppText>
        </View>
      </View>

      <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.3, color: colors.textDim }}>
        {`${businessName ?? 'no lead'} · DUE ${relativeFromIso(item.due_at)} · REVISIONS ${item.revisions_used}/${item.revisions_included}`}
      </AppText>

      {item.artifact_url ? (
        <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0, color: colors.cyan }}>
          {item.artifact_url}
        </AppText>
      ) : null}

      {item.revision_note ? (
        <AppText variant="caption" style={{ color: colors.amber }}>
          {item.revision_note}
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {item.status === 'pending' || item.status === 'revision_requested' ? (
          <ActionButton
            label={item.status === 'pending' ? 'START WORK' : 'RESUME WORK'}
            color={colors.cyan}
            onPress={onStart}
            disabled={busy}
          />
        ) : null}

        {canDeliver ? (
          <ActionButton
            label="MARK DELIVERED"
            color={colors.emerald}
            onPress={() => {
              setMode(mode === 'link' ? 'none' : 'link');
              setText('');
            }}
            disabled={busy}
          />
        ) : null}

        {item.status === 'delivered' ? (
          <ActionButton
            label="ACCEPT"
            color={colors.success}
            onPress={onAccept}
            disabled={busy}
          />
        ) : null}

        {canRevise ? (
          <ActionButton
            label={`REQUEST REVISION (${revisionsLeft} LEFT)`}
            color={colors.amber}
            onPress={() => {
              setMode(mode === 'note' ? 'none' : 'note');
              setText('');
            }}
            disabled={busy}
          />
        ) : null}
      </View>

      {mode === 'link' ? (
        <View style={{ gap: spacing.sm }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="https://link to the delivered work"
            placeholderTextColor={colors.textDim}
            autoCapitalize="none"
            autoCorrect={false}
            maxLength={500}
            style={inputStyle}
          />
          <ActionButton
            label="RECORD DELIVERY"
            color={colors.emerald}
            onPress={() => {
              const url = text.trim();
              if (url.length < 10) return;
              onDeliver(url);
              setMode('none');
              setText('');
            }}
            disabled={busy || text.trim().length < 10}
          />
        </View>
      ) : null}

      {mode === 'note' ? (
        <View style={{ gap: spacing.sm }}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="What should change?"
            placeholderTextColor={colors.textDim}
            maxLength={1000}
            multiline
            style={[inputStyle, { minHeight: 60, textAlignVertical: 'top' }]}
          />
          <ActionButton
            label="SEND REVISION REQUEST"
            color={colors.amber}
            onPress={() => {
              const note = text.trim();
              if (note.length < 3) return;
              onRevision(note);
              setMode('none');
              setText('');
            }}
            disabled={busy || text.trim().length < 3}
          />
        </View>
      ) : null}
    </View>
  );
}

function AcceptedQuoteRow({
  quote,
  businessName,
  busy,
  onOpen,
}: {
  quote: CloudQuote;
  businessName: string | null;
  busy: boolean;
  onOpen: () => void;
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
      <AppText variant="bodyStrong" style={{ fontSize: 13.5 }} numberOfLines={1}>
        {quote.title}
      </AppText>
      <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.3, color: colors.textDim }}>
        {`${businessName ?? 'no lead'} · ACCEPTED ${relativeFromIso(quote.accepted_at)} · ${quote.delivery_days} DAYS`}
      </AppText>
      <ActionButton label="OPEN DELIVERY" color={colors.cyan} onPress={onOpen} disabled={busy} />
    </View>
  );
}

export default function DeliveryScreen() {
  const cloud = useCloud();
  const router = useRouter();

  const businessName = (id: string | null): string | null => {
    if (!id) return null;
    return cloud.leads.find((lead) => lead.id === id)?.business_name ?? null;
  };

  const toOpen = cloud.quotes.filter(
    (quote) =>
      quote.status === 'accepted' &&
      !cloud.deliverables.some((item) => item.quote_id === quote.id),
  );

  const open = cloud.deliverables.filter((item) => !CLOSED.includes(item.status));
  const done = cloud.deliverables.filter((item) => CLOSED.includes(item.status));
  const busy = cloud.busy === 'delivery';

  if (!cloud.session) {
    return (
      <Screen eyebrow="Nova OS" title="Delivery" subtitle="Track the work you owe.">
        <Panel accent={colors.amber}>
          <EmptyState
            icon="lock-closed-outline"
            title="Sign in to the cloud"
            body="Deliveries live in the cloud. Sign in on the Cloud screen to read and update them."
            actionLabel="Open cloud"
            onAction={() => router.push('/cloud')}
          />
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen eyebrow="Nova OS" title="Delivery" subtitle="Accepted work, and its evidence.">
      <FadeInView>
        <Panel>
          <AppText variant="caption">
            A delivery starts only from an accepted quote. Marking it delivered needs a link to the
            real work, acceptance is your own decision, and revisions stop at the number included in
            the service. When payments are live, delivery cannot start until the payment is recorded.
          </AppText>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
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
                label="Pipeline"
                icon="git-branch-outline"
                variant="ghost"
                onPress={() => router.push('/pipeline')}
              />
            </View>
          </View>
        </Panel>
      </FadeInView>

      {toOpen.length > 0 ? (
        <FadeInView delay={30} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label={`Accepted quotes with no delivery · ${toOpen.length}`} />
          <Panel padded={false}>
            {toOpen.map((quote) => (
              <AcceptedQuoteRow
                key={quote.id}
                quote={quote}
                businessName={businessName(quote.lead_id)}
                busy={busy}
                onOpen={() => void cloud.openDelivery(quote.id)}
              />
            ))}
          </Panel>
        </FadeInView>
      ) : null}

      <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Open work · ${open.length}`} />
        <Panel padded={false}>
          {open.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <EmptyState
                compact
                icon="cube-outline"
                title="No open deliveries"
                body="An accepted quote can be opened as a delivery above. Nothing is created here by hand."
              />
            </View>
          ) : (
            open.map((item) => (
              <DeliverableRow
                key={item.id}
                item={item}
                businessName={businessName(item.lead_id)}
                busy={busy}
                onStart={() => void cloud.startDeliverable(item.id)}
                onDeliver={(url) => void cloud.deliverWork(item.id, url)}
                onAccept={() => void cloud.acceptWork(item.id)}
                onRevision={(note) => void cloud.requestRevision(item.id, note)}
              />
            ))
          )}
        </Panel>
      </FadeInView>

      {done.length > 0 ? (
        <FadeInView delay={90} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label={`Accepted · ${done.length}`} />
          <Panel padded={false}>
            {done.map((item) => (
              <DeliverableRow
                key={item.id}
                item={item}
                businessName={businessName(item.lead_id)}
                busy={busy}
                onStart={() => {}}
                onDeliver={() => {}}
                onAccept={() => {}}
                onRevision={() => {}}
              />
            ))}
          </Panel>
        </FadeInView>
      ) : null}
    </Screen>
  );
}
