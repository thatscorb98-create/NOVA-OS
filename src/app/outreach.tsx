import React, { useState } from 'react';
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
  OUTREACH_STATUS_LABEL,
  type CloudOutreachMessage,
  type OutreachStatus,
} from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, radius, spacing } from '@/theme';

/**
 * Outreach review.
 *
 * This screen reads and approves. It cannot send: sending needs email switched
 * on in company settings, a verified sender and a provider key, and the worker
 * re-checks all of that at the moment it would send. Approving here only marks a
 * draft as ready.
 */

const OPEN_STATUSES: OutreachStatus[] = ['draft', 'approved', 'sending'];

function statusTone(status: OutreachStatus): string {
  switch (status) {
    case 'approved':
      return colors.cyan;
    case 'sent':
      return colors.success;
    case 'replied':
      return colors.emerald;
    case 'failed':
    case 'bounced':
      return colors.danger;
    case 'cancelled':
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

function MessageCard({
  message,
  leadName,
  expanded,
  onToggle,
  onApprove,
  approving,
}: {
  message: CloudOutreachMessage;
  leadName: string | null;
  expanded: boolean;
  onToggle: () => void;
  onApprove: () => void;
  approving: boolean;
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
      <Pressable onPress={onToggle} style={{ gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }} numberOfLines={1}>
            {message.subject}
          </AppText>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 }}>
            <StatusDot color={statusTone(message.status)} size={5} />
            <AppText variant="micro" style={{ color: statusTone(message.status) }}>
              {OUTREACH_STATUS_LABEL[message.status]}
            </AppText>
          </View>
        </View>

        <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.4 }}>
          {`${message.to_name ? `${message.to_name} · ` : ''}${message.to_email}`}
        </AppText>

        <AppText variant="micro" numberOfLines={1} style={{ color: colors.textDim, letterSpacing: 0.3 }}>
          {leadName ? `${leadName} · ` : ''}
          {`DRAFTED ${relativeFromIso(message.created_at)}`}
          {message.approved_at ? ` · APPROVED ${relativeFromIso(message.approved_at)}` : ''}
          {message.sent_at ? ` · SENT ${relativeFromIso(message.sent_at)}` : ''}
        </AppText>

        {!expanded ? (
          <AppText variant="caption" numberOfLines={2} style={{ marginTop: 2 }}>
            {message.body}
          </AppText>
        ) : null}
      </Pressable>

      {expanded ? (
        <View
          style={{
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.panelBorder,
            backgroundColor: 'rgba(10, 14, 28, 0.9)',
            padding: spacing.md,
          }}
        >
          <AppText variant="caption" style={{ lineHeight: 20 }}>
            {message.body}
          </AppText>
        </View>
      ) : null}

      {message.failed_reason ? (
        <AppText variant="micro" style={{ color: colors.danger, letterSpacing: 0 }}>
          {message.failed_reason}
        </AppText>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Pressable onPress={onToggle} style={{ paddingVertical: spacing.xs }}>
          <AppText variant="micro" style={{ color: colors.cyan, letterSpacing: 0.6 }}>
            {expanded ? 'COLLAPSE' : 'READ FULL DRAFT'}
          </AppText>
        </Pressable>

        <View style={{ flex: 1 }} />

        {message.status === 'draft' ? (
          <Pressable
            onPress={onApprove}
            disabled={approving}
            style={({ pressed }) => ({
              opacity: approving ? 0.5 : pressed ? 0.7 : 1,
              paddingHorizontal: spacing.lg,
              paddingVertical: spacing.sm,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: `${colors.violet}55`,
              backgroundColor: 'rgba(139, 92, 246, 0.12)',
            })}
          >
            <AppText variant="micro" style={{ color: colors.violetBright }}>
              {approving ? 'APPROVING' : 'APPROVE'}
            </AppText>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

export default function OutreachScreen() {
  const cloud = useCloud();
  const router = useRouter();

  const [expanded, setExpanded] = useState<string | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);

  const settings = cloud.health?.settings;
  const account = cloud.emailAccount;
  const emailEnabled = settings?.email_enabled ?? false;

  const leadName = (id: string | null): string | null => {
    if (!id) return null;
    return cloud.leads.find((lead) => lead.id === id)?.business_name ?? null;
  };

  const suppressed = new Set(cloud.suppressedEmails.map((email) => email.toLowerCase()));

  /**
   * A lead is only draftable when there is a real address to write to: a stored
   * contact that has not opted out and is not on the suppression list. The
   * worker re-checks all of this, so this filter only hides dead ends.
   */
  const usableContact = (leadId: string) =>
    cloud.contacts.find((contact) => {
      if (contact.lead_id !== leadId || contact.opted_out) return false;
      const address = (contact.email_normalized ?? contact.email ?? '').toLowerCase().trim();
      if (!address.includes('@') || address.length < 4) return false;
      return !suppressed.has(address);
    }) ?? null;

  const drafts = cloud.outreach.filter((message) => message.status === 'draft');
  const approved = cloud.outreach.filter((message) => message.status === 'approved');
  const history = cloud.outreach.filter((message) => !OPEN_STATUSES.includes(message.status));

  const readyLeads = cloud.leads.filter(
    (lead) =>
      (lead.status === 'qualified' || lead.status === 'researched') &&
      usableContact(lead.id) !== null &&
      !cloud.outreach.some(
        (message) => message.lead_id === lead.id && OPEN_STATUSES.includes(message.status),
      ),
  );

  const leadsWithoutContact = cloud.leads.filter(
    (lead) =>
      (lead.status === 'qualified' || lead.status === 'researched') &&
      usableContact(lead.id) === null,
  ).length;

  const approve = async (id: string) => {
    setApprovingId(id);
    await cloud.approveMessage(id);
    setApprovingId(null);
  };

  if (!cloud.session) {
    return (
      <Screen eyebrow="Nova OS" title="Outreach" subtitle="Review and approve drafts.">
        <Panel accent={colors.amber}>
          <EmptyState
            icon="lock-closed-outline"
            title="Sign in to the cloud"
            body="Drafts live in the cloud. Sign in on the Cloud screen to read and approve them."
            actionLabel="Open cloud"
            onAction={() => router.push('/cloud')}
          />
        </Panel>
      </Screen>
    );
  }

  const accountLine = !account
    ? 'No sending account is set up, so nothing can send.'
    : account.enabled && account.verified
      ? `Sender ${account.from_email ?? 'unknown'} is verified.`
      : `Sender ${account.from_email ?? 'unset'} is not verified, so nothing can send.`;

  return (
    <Screen
      eyebrow="Nova OS"
      title="Outreach"
      subtitle="Email drafts, built from facts already on file."
    >
      <FadeInView>
        <Panel accent={emailEnabled ? colors.cyan : colors.amber}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={emailEnabled ? colors.cyan : colors.amber} size={7} />
            <AppText variant="heading">
              {emailEnabled ? 'EMAIL ON' : 'SENDING OFF'}
            </AppText>
          </View>

          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {emailEnabled
              ? 'Email is switched on. The worker still re-checks the sender, the cap and the suppression list before every send.'
              : 'Approving a draft does not send it. Sending stays disabled until email is switched on in company settings and a sender is verified.'}
          </AppText>

          <AppText variant="micro" style={{ marginTop: spacing.sm, letterSpacing: 0.4 }}>
            {accountLine}
          </AppText>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <View style={{ flex: 1 }}>
              <NeonButton
                label="Run worker"
                icon="flash-outline"
                variant="ghost"
                onPress={() => void cloud.runWorker()}
                loading={cloud.busy === 'worker'}
              />
            </View>
            <View style={{ flex: 1 }}>
              <NeonButton
                label="Company"
                icon="business-outline"
                variant="ghost"
                onPress={() => router.push('/company')}
              />
            </View>
          </View>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
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

      <FadeInView delay={40} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Drafts to review · ${drafts.length}`} />
        <Panel padded={false}>
          {drafts.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <EmptyState
                compact
                icon="mail-outline"
                title="No drafts waiting"
                body="Queue a draft for a qualified lead below, then run the worker. The text is written from stored facts only."
              />
            </View>
          ) : (
            drafts.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                leadName={leadName(message.lead_id)}
                expanded={expanded === message.id}
                onToggle={() => setExpanded(expanded === message.id ? null : message.id)}
                onApprove={() => void approve(message.id)}
                approving={approvingId === message.id}
              />
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={80} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Approved, not sent · ${approved.length}`} />
        <Panel padded={false}>
          {approved.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">
                Approved drafts wait here. Nothing leaves this list until email is on, a sender is
                verified and the worker sends it.
              </AppText>
            </View>
          ) : (
            approved.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                leadName={leadName(message.lead_id)}
                expanded={expanded === message.id}
                onToggle={() => setExpanded(expanded === message.id ? null : message.id)}
                onApprove={() => {}}
                approving={false}
              />
            ))
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label={`Ready to draft · ${readyLeads.length}`} />
        <Panel padded={false}>
          {readyLeads.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <AppText variant="caption">
                No lead with a usable contact is waiting. A ready lead needs a stored public address
                that has not opted out or been suppressed, and no open draft. New leads appear here
                after discovery scores them.
                {leadsWithoutContact > 0
                  ? ` ${leadsWithoutContact} scored lead(s) are hidden because no usable contact is on file.`
                  : ''}
              </AppText>
            </View>
          ) : (
            readyLeads.map((lead) => (
              <View
                key={lead.id}
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
                    {lead.business_name}
                  </AppText>
                  <AppText variant="micro" style={{ color: colors.textDim }}>
                    {lead.score === null ? 'UNSCORED' : `${lead.score}/100`}
                  </AppText>
                </View>
                <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.4 }}>
                  {lead.domain ?? 'no website'} · {lead.status.toUpperCase()}
                </AppText>
                <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.4, color: colors.textDim }}>
                  {`TO ${usableContact(lead.id)?.email_normalized ?? usableContact(lead.id)?.email}`}
                </AppText>
                <Pressable
                  onPress={() => void cloud.draftForLead(lead.id)}
                  disabled={cloud.busy === 'outreach'}
                  style={({ pressed }) => ({
                    alignSelf: 'flex-start',
                    opacity: cloud.busy === 'outreach' ? 0.5 : pressed ? 0.7 : 1,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.sm,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: `${colors.cyan}55`,
                    backgroundColor: 'rgba(34, 211, 238, 0.10)',
                  })}
                >
                  <AppText variant="micro" style={{ color: colors.cyan }}>
                    QUEUE DRAFT
                  </AppText>
                </Pressable>
              </View>
            ))
          )}
        </Panel>
      </FadeInView>

      {history.length > 0 ? (
        <FadeInView delay={160} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label={`History · ${history.length}`} />
          <Panel padded={false}>
            {history.map((message) => (
              <View
                key={message.id}
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
                    {message.subject}
                  </AppText>
                  <AppText variant="micro" style={{ color: statusTone(message.status) }}>
                    {OUTREACH_STATUS_LABEL[message.status]}
                  </AppText>
                </View>
                <AppText variant="micro" numberOfLines={1} style={{ letterSpacing: 0.4 }}>
                  {`${message.to_email} · ${relativeFromIso(message.sent_at ?? message.created_at)}`}
                </AppText>
              </View>
            ))}
          </Panel>
        </FadeInView>
      ) : null}

      <FadeInView delay={200} style={{ marginTop: spacing.xxl }}>
        <Panel>
          <AppText variant="caption">
            A draft restates the lead&apos;s own stored facts: its name, its public page, its scoring
            reasons and your catalog entry. NOVA does not write claims it cannot point at, and every
            draft carries an opt-out line.
          </AppText>
        </Panel>
      </FadeInView>
    </Screen>
  );
}
