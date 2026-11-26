import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { StatusDot } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Screen } from '@/components/ui/Screen';
import {
  DEAL_STAGE_LABEL,
  REPLY_INTENT_LABEL,
  type CloudDeal,
  type CloudReply,
  type DealStage,
  type ReplyIntent,
} from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, radius, spacing } from '@/theme';

/**
 * Pipeline.
 *
 * Deals move on real events: discovery creates one, a sent email moves it to
 * contacted, and a real reply moves it to replied, lost or do-not-contact. The
 * only manual actions are the owner's own "won" and "lost" judgements.
 */

const CLOSED: DealStage[] = ['won', 'lost', 'do_not_contact'];

function relativeFromIso(iso: string | null): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatRelative(parsed) : 'unknown';
}

function stageTone(stage: DealStage): string {
  switch (stage) {
    case 'won':
      return colors.success;
    case 'ready_to_purchase':
      return colors.emerald;
    case 'replied':
    case 'interested':
      return colors.cyan;
    case 'lost':
    case 'do_not_contact':
      return colors.danger;
    case 'qualified':
    case 'contacted':
      return colors.violetBright;
    default:
      return colors.textDim;
  }
}

function DealRow({
  deal,
  businessName,
  onWin,
  onLose,
  busy,
}: {
  deal: CloudDeal;
  businessName: string | null;
  onWin: () => void;
  onLose: () => void;
  busy: boolean;
}) {
  const closed = CLOSED.includes(deal.stage);

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
          {businessName ?? 'no lead'}
        </AppText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 }}>
          <StatusDot color={stageTone(deal.stage)} size={5} />
          <AppText variant="micro" style={{ color: stageTone(deal.stage) }}>
            {DEAL_STAGE_LABEL[deal.stage]}
          </AppText>
        </View>
      </View>

      <AppText variant="micro" numberOfLines={2} style={{ letterSpacing: 0.3, color: colors.textDim }}>
        {`UPDATED ${relativeFromIso(deal.updated_at)}${
          deal.next_action ? ` · ${deal.next_action}` : ''
        }`}
      </AppText>

      {!closed ? (
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Pressable
            onPress={onWin}
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
              MARK WON
            </AppText>
          </Pressable>
          <Pressable
            onPress={onLose}
            disabled={busy}
            style={({ pressed }) => ({
              opacity: busy ? 0.5 : pressed ? 0.7 : 1,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: `${colors.danger}55`,
              backgroundColor: 'rgba(248, 113, 113, 0.08)',
            })}
          >
            <AppText variant="micro" style={{ color: colors.danger }}>
              MARK LOST
            </AppText>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

function ReplyRow({ reply, subject }: { reply: CloudReply; subject: string | null }) {
  const intent = (reply.intent ?? 'other') as ReplyIntent;

  const tone =
    intent === 'unsubscribe' || intent === 'not_interested'
      ? colors.danger
      : intent === 'question' || intent === 'interested'
        ? colors.cyan
        : colors.textDim;

  return (
    <View
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
          {subject ?? reply.kind.toUpperCase()}
        </AppText>
        <AppText variant="micro" style={{ color: tone }}>
          {REPLY_INTENT_LABEL[intent]}
        </AppText>
      </View>
      <AppText variant="micro" numberOfLines={2} style={{ letterSpacing: 0.3, color: colors.textDim }}>
        {`${reply.kind.toUpperCase()} · ${relativeFromIso(reply.created_at)}${
          reply.detail ? ` · ${reply.detail}` : ''
        }`}
      </AppText>
    </View>
  );
}

export default function PipelineScreen() {
  const cloud = useCloud();
  const router = useRouter();

  const businessName = (id: string | null): string | null => {
    if (!id) return null;
    return cloud.leads.find((lead) => lead.id === id)?.business_name ?? null;
  };

  const subjectFor = (messageId: string | null): string | null => {
    if (!messageId) return null;
    return cloud.outreach.find((message) => message.id === messageId)?.subject ?? null;
  };

  const open = cloud.deals.filter((deal) => !CLOSED.includes(deal.stage));
  const closed = cloud.deals.filter((deal) => CLOSED.includes(deal.stage));

  if (!cloud.session) {
    return (
      <Screen eyebrow="Nova OS" title="Pipeline" subtitle="Deals, replies and next actions.">
        <Panel accent={colors.amber}>
          <EmptyState
            icon="lock-closed-outline"
            title="Sign in to the cloud"
            body="The pipeline lives in the cloud. Sign in on the Cloud screen to read it."
            actionLabel="Open cloud"
            onAction={() => router.push('/cloud')}
          />
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen eyebrow="Nova OS" title="Pipeline" subtitle="What actually happened, and what is next.">
      <FadeInView>
        <Panel>
          <AppText variant="caption">
            A deal moves on evidence: discovery creates it, a sent email marks it contacted, and a real
            reply marks it replied. Nothing advances because time passed.
          </AppText>
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
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
                label="Quotes"
                icon="document-text-outline"
                variant="ghost"
                onPress={() => router.push('/quotes')}
              />
            </View>
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={40} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Open deals · ${open.length}`} />
        <Panel padded={false}>
          {open.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <EmptyState
                compact
                icon="git-branch-outline"
                title="No open deals"
                body="A deal appears when discovery keeps a lead it can reach. Nothing is created here by hand."
              />
            </View>
          ) : (
            open.map((deal) => (
              <DealRow
                key={deal.id}
                deal={deal}
                businessName={businessName(deal.lead_id)}
                onWin={() => void cloud.setDealStage(deal.id, 'won')}
                onLose={() => void cloud.setDealStage(deal.id, 'lost')}
                busy={cloud.busy === 'deal'}
              />
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={80} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Replies · ${cloud.replies.length}`} />
        <Panel padded={false}>
          {cloud.replies.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">
                No reply has been reported yet. The provider webhook records each one, and an opt-out
                suppresses the address immediately.
              </AppText>
            </View>
          ) : (
            cloud.replies.map((reply) => (
              <ReplyRow
                key={reply.id}
                reply={reply}
                subject={subjectFor(reply.message_id)}
              />
            ))
          )}
        </Panel>
        <AppText variant="micro" style={{ marginTop: spacing.sm, letterSpacing: 0.3, color: colors.textDim }}>
          The intent label is a keyword hint derived from the reply text, not a claim about what the
          customer meant. Read the reply before acting on it.
        </AppText>
      </FadeInView>

      {closed.length > 0 ? (
        <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label={`Closed · ${closed.length}`} />
          <Panel padded={false}>
            {closed.map((deal) => (
              <DealRow
                key={deal.id}
                deal={deal}
                businessName={businessName(deal.lead_id)}
                onWin={() => {}}
                onLose={() => {}}
                busy
              />
            ))}
          </Panel>
        </FadeInView>
      ) : null}
    </Screen>
  );
}
