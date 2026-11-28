import React, { useState } from 'react';
import { Alert, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusDot } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { FormField } from '@/components/ui/FormField';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Screen } from '@/components/ui/Screen';
import { AUTONOMY_MODES } from '@/lib/cloud/types';
import type { CloudJobStatus } from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, radius, spacing } from '@/theme';

function relativeFromIso(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatRelative(parsed) : 'unknown';
}

function statusTone(status: CloudJobStatus): string {
  switch (status) {
    case 'succeeded':
      return colors.success;
    case 'running':
      return colors.cyan;
    case 'queued':
      return colors.violetBright;
    case 'failed':
    case 'dead':
      return colors.danger;
    default:
      return colors.textDim;
  }
}

function cycleTone(status: 'action' | 'idle' | 'paused' | 'blocked' | 'error'): string {
  switch (status) {
    case 'action':
      return colors.success;
    case 'blocked':
    case 'error':
      return colors.danger;
    case 'paused':
      return colors.amber;
    default:
      return colors.textDim;
  }
}

function Row({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: spacing.sm + 2,
      }}
    >
      <AppText variant="micro" style={{ letterSpacing: 1 }}>
        {label.toUpperCase()}
      </AppText>
      <AppText
        variant="bodyStrong"
        numberOfLines={1}
        style={{ fontSize: 13, color: color ?? colors.text, maxWidth: '62%' }}
      >
        {value}
      </AppText>
    </View>
  );
}

export default function CloudScreen() {
  const cloud = useCloud();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const signedIn = Boolean(cloud.session);
  const health = cloud.health;
  const mode = health?.settings?.autonomy_mode ?? 'paused';

  const headline =
    cloud.status === 'online'
      ? 'CLOUD ONLINE'
      : cloud.status === 'connecting'
        ? 'CONNECTING'
        : cloud.status === 'error'
          ? 'CLOUD ERROR'
          : cloud.status === 'signed_out'
            ? 'NOT SIGNED IN'
            : 'NOT CONFIGURED';

  const accent =
    cloud.status === 'online'
      ? colors.success
      : cloud.status === 'error'
        ? colors.danger
        : cloud.status === 'connecting'
          ? colors.cyan
          : colors.amber;

  const handleSignOut = () => {
    Alert.alert('Sign out of the cloud?', 'Your local workspace stays on this phone.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void cloud.signOut() },
    ]);
  };

  return (
    <Screen
      eyebrow="Nova OS"
      title="Cloud"
      subtitle="Company operations, queue and worker."
    >
      <FadeInView>
        <Panel accent={accent}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={accent} size={7} />
            <AppText variant="heading">{headline}</AppText>
          </View>
          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {cloud.status === 'unconfigured'
              ? 'No cloud project is connected. The app keeps working entirely on this phone; add the two public Supabase values to enable the queue and the worker.'
              : cloud.status === 'signed_out'
                ? 'The project is configured. Sign in to reach the persistent queue, company memory and the worker that runs when this phone is closed.'
                : cloud.status === 'online'
                  ? 'The queue, company memory and worker are reachable. Local missions and conversations are unaffected.'
                  : cloud.status === 'error'
                    ? 'The project is configured but the last request failed. Check the message below, then refresh.'
                    : 'Reaching the cloud project…'}
          </AppText>
          {signedIn ? (
            <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.hairline }}>
              <Row label="Account" value={cloud.session?.user.email ?? 'signed in'} />
              <Row label="Checked" value={relativeFromIso(health?.checked_at)} color={colors.textMuted} />
            </View>
          ) : null}
        </Panel>
      </FadeInView>

      {cloud.lastError ? (
        <FadeInView delay={30} style={{ marginTop: spacing.md }}>
          <Panel accent={colors.danger}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
              <Ionicons name="alert-circle" size={15} color={colors.danger} style={{ marginTop: 1 }} />
              <AppText variant="caption" style={{ flex: 1 }}>
                {cloud.lastError}
              </AppText>
            </View>
          </Panel>
        </FadeInView>
      ) : null}

      {cloud.lastMessage ? (
        <FadeInView delay={30} style={{ marginTop: spacing.md }}>
          <Panel accent={colors.success}>
            <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
              <Ionicons
                name="checkmark-circle"
                size={15}
                color={colors.success}
                style={{ marginTop: 1 }}
              />
              <AppText variant="caption" style={{ flex: 1 }}>
                {cloud.lastMessage}
              </AppText>
            </View>
          </Panel>
        </FadeInView>
      ) : null}

      {cloud.status === 'unconfigured' ? (
        <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label="Connect a project" />
          <Panel style={{ gap: spacing.md }}>
            <AppText variant="caption">
              Create a Supabase project, run the two migrations in this repository, then copy
              `.env.example` to `.env` and fill in the public values. Restart the dev server so Expo
              picks them up.
            </AppText>

            <View style={{ gap: spacing.sm }}>
              {cloud.missingVariables.map((name) => (
                <View
                  key={name}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    padding: spacing.md,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: `${colors.amber}44`,
                    backgroundColor: `${colors.amber}10`,
                  }}
                >
                  <Ionicons name="key-outline" size={14} color={colors.amber} />
                  <AppText variant="bodyStrong" style={{ fontSize: 12.5, flex: 1 }}>
                    {name}
                  </AppText>
                  <AppText variant="micro" style={{ color: colors.amber }}>
                    MISSING
                  </AppText>
                </View>
              ))}
            </View>

            <AppText variant="caption">
              The anon key is public and safe in the bundle: row level security limits every row to
              the signed-in owner. A service-role key must never be placed in the app — the worker
              and scheduler read it from Supabase function secrets only.
            </AppText>
          </Panel>
        </FadeInView>
      ) : null}

      {cloud.configured && !signedIn ? (
        <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label="Owner sign in" />
          <Panel style={{ gap: spacing.md }}>
            <FormField
              label="Email"
              placeholder="you@example.com"
              value={email}
              onChangeText={setEmail}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              maxLength={200}
            />
            <FormField
              label="Password"
              placeholder="••••••••"
              value={password}
              onChangeText={setPassword}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              maxLength={200}
            />

            <NeonButton
              label="Sign in"
              icon="log-in-outline"
              onPress={() => void cloud.signIn(email, password)}
              loading={cloud.busy === 'signin'}
              disabled={!email.trim() || password.length < 6}
            />
            <NeonButton
              label="Create owner account"
              icon="person-add-outline"
              variant="ghost"
              onPress={() => void cloud.signUp(email, password)}
              loading={cloud.busy === 'signup'}
              disabled={!email.trim() || password.length < 6}
            />

            <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
              THE FIRST ACCOUNT BECOMES THE OWNER OF ITS OWN ROWS. SUPABASE MAY ASK YOU TO CONFIRM
              YOUR EMAIL BEFORE THE FIRST SIGN IN.
            </AppText>
          </Panel>
        </FadeInView>
      ) : null}

      {signedIn ? (
        <>
          <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
            <SectionHeader
              label="Queue"
              actionLabel={cloud.busy === 'refresh' ? 'Refreshing' : 'Refresh'}
              onAction={() => void cloud.refresh()}
            />
            <Panel>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <StatBlock value={String(health?.queue.queued ?? 0)} label="Queued" accent={colors.violetBright} />
                <StatBlock value={String(health?.queue.running ?? 0)} label="Running" accent={colors.cyan} />
              </View>
              <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
                <StatBlock value={String(health?.queue.dead ?? 0)} label="Dead" accent={colors.danger} />
                <StatBlock
                  value={String(health?.queue.succeeded24h ?? 0)}
                  label="Done 24h"
                  accent={colors.success}
                />
              </View>

              <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.hairline }}>
                <Row
                  label="Worker"
                  value={
                    health?.worker
                      ? `${health.worker.alive ? 'alive' : 'stale'} · ${relativeFromIso(
                          health.worker.last_seen_at,
                        )}`
                      : 'never seen'
                  }
                  color={health?.worker?.alive ? colors.success : colors.amber}
                />
                <Row
                  label="Company memory"
                  value={String(health?.counts.memories ?? 0)}
                  color={colors.emerald}
                />
                <Row label="Leads" value={String(health?.counts.leads ?? 0)} />
                <Row label="Events 24h" value={String(health?.counts.events24h ?? 0)} />
              </View>
            </Panel>
          </FadeInView>

          <FadeInView delay={90} style={{ marginTop: spacing.xxl }}>
            <SectionHeader label="Worker controls" />
            <Panel style={{ gap: spacing.sm }}>
              <AppText variant="caption">
                Running the worker here drains this owner&apos;s queue immediately. The scheduler does
                the same thing on a cron trigger, so work continues while the app is closed.
              </AppText>
              <NeonButton
                label="Run worker now"
                icon="flash-outline"
                onPress={() => void cloud.runWorker()}
                loading={cloud.busy === 'worker'}
              />
              <NeonButton
                label="Queue a test job"
                icon="pulse-outline"
                variant="ghost"
                onPress={() => void cloud.queuePing()}
                loading={cloud.busy === 'ping'}
              />
              <NeonButton
                label="Import local memory"
                icon="cloud-upload-outline"
                variant="ghost"
                onPress={() => void cloud.syncMemory()}
                loading={cloud.busy === 'sync'}
              />
              <NeonButton
                label="Open company"
                icon="briefcase-outline"
                variant="ghost"
                onPress={() => router.push('/company')}
              />
              <NeonButton
                label="Sign out"
                icon="log-out-outline"
                variant="ghost"
                onPress={handleSignOut}
              />
            </Panel>
          </FadeInView>

          <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
            <SectionHeader label="Company mode" />
            <Panel style={{ gap: spacing.md }}>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {AUTONOMY_MODES.map((option) => (
                  <Chip
                    key={option.key}
                    label={option.label}
                    color={option.key === 'paused' ? colors.amber : colors.violet}
                    active={mode === option.key}
                    onPress={() => void cloud.setMode(option.key)}
                  />
                ))}
              </View>
              <AppText variant="caption">
                {AUTONOMY_MODES.find((option) => option.key === mode)?.note ??
                  'The company starts paused.'}
              </AppText>
              <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
                PAUSED DEFERS NON-SYSTEM WORK WITHOUT SPENDING AN ATTEMPT. LIVE EMAIL, PAYMENTS AND
                PRODUCTION STAY OFF UNTIL THEIR PHASE HAS PASSED ITS TESTS.
              </AppText>
            </Panel>
          </FadeInView>

          {cloud.loopSnapshot ? (
            <FadeInView delay={140} style={{ marginTop: spacing.xxl }}>
              <SectionHeader label="Autonomous loop" />
              <Panel>
                <AppText variant="caption">
                  The scheduler queues one company cycle per minute while the company is not paused.
                  Each cycle reviews the business and queues at most one action. It never creates a
                  quote, a payment or a checkout, and it cannot buy or upgrade anything.
                </AppText>

                <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
                  <StatBlock
                    value={String(cloud.loopSnapshot.counts.dueFollowUps)}
                    label="Due follow-ups"
                    accent={colors.violetBright}
                  />
                  <StatBlock
                    value={String(cloud.loopSnapshot.counts.approvedReady)}
                    label="Approved mail"
                    accent={colors.cyan}
                  />
                </View>
                <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm }}>
                  <StatBlock
                    value={String(cloud.loopSnapshot.counts.deliveriesUnsent)}
                    label="To deliver"
                    accent={colors.emerald}
                  />
                  <StatBlock
                    value={String(cloud.loopSnapshot.counts.leadsWithoutOutreach)}
                    label="Leads to draft"
                    accent={colors.success}
                  />
                </View>

                <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.hairline }}>
                  <Row
                    label="AI budget"
                    value={
                      cloud.loopSnapshot.aiBudgetCents === 0
                        ? 'not funded — no paid AI spend'
                        : `$${(cloud.loopSnapshot.aiSpendCents / 100).toFixed(2)} of $${(
                            cloud.loopSnapshot.aiBudgetCents / 100
                          ).toFixed(2)}`
                    }
                    color={
                      cloud.loopSnapshot.aiRemainingCents > 0 ? colors.success : colors.textMuted
                    }
                  />
                  <Row
                    label="Last cycle"
                    value={relativeFromIso(cloud.companyCycles[0]?.created_at)}
                  />
                </View>

                <View style={{ marginTop: spacing.sm }}>
                  <NeonButton
                    label="Run company cycle"
                    icon="sync-outline"
                    onPress={() => void cloud.runCompanyCycle()}
                    loading={cloud.busy === 'worker'}
                  />
                </View>

                {cloud.companyCycles.length > 0 ? (
                  <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.hairline }}>
                    {cloud.companyCycles.slice(0, 5).map((cycle, index) => (
                      <View
                        key={cycle.id}
                        style={{
                          paddingVertical: spacing.sm + 2,
                          borderTopWidth: index === 0 ? 0 : 1,
                          borderTopColor: colors.hairline,
                          gap: 2,
                        }}
                      >
                        <View
                          style={{
                            flexDirection: 'row',
                            alignItems: 'center',
                            gap: spacing.xs + 2,
                          }}
                        >
                          <StatusDot color={cycleTone(cycle.status)} size={5} />
                          <AppText variant="micro" style={{ color: cycleTone(cycle.status), flex: 1 }}>
                            {cycle.decision.replace(/_/g, ' ').toUpperCase()}
                          </AppText>
                          <AppText variant="micro">{relativeFromIso(cycle.created_at)}</AppText>
                        </View>
                        {cycle.status === 'blocked' && typeof cycle.detail.reason === 'string' ? (
                          <AppText variant="micro" style={{ color: colors.amber, letterSpacing: 0 }}>
                            {cycle.detail.reason}
                          </AppText>
                        ) : null}
                      </View>
                    ))}
                  </View>
                ) : (
                  <AppText variant="micro" style={{ marginTop: spacing.md, letterSpacing: 0.4 }}>
                    NO CYCLE HAS RUN YET. QUEUE ONE HERE OR LET THE SCHEDULER CALL IT.
                  </AppText>
                )}
              </Panel>
            </FadeInView>
          ) : null}

          <FadeInView delay={150} style={{ marginTop: spacing.xxl }}>
            <SectionHeader label="Recent jobs" />
            <Panel padded={false}>
              {cloud.jobs.length === 0 ? (
                <View style={{ padding: spacing.lg }}>
                  <EmptyState
                    compact
                    icon="layers-outline"
                    title="No jobs yet"
                    body="Queue a test job to prove the worker, the queue and the event log end to end."
                  />
                </View>
              ) : (
                cloud.jobs.map((job, index) => (
                  <View
                    key={job.id}
                    style={{
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.md,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: colors.hairline,
                      gap: 3,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: spacing.sm,
                      }}
                    >
                      <AppText variant="bodyStrong" style={{ fontSize: 13, flex: 1 }} numberOfLines={1}>
                        {job.kind}
                      </AppText>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs + 2 }}>
                        <StatusDot color={statusTone(job.status)} size={5} />
                        <AppText variant="micro" style={{ color: statusTone(job.status) }}>
                          {job.status.toUpperCase()}
                        </AppText>
                      </View>
                    </View>
                    <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
                      {`ATTEMPT ${job.attempts}/${job.max_attempts} · ${relativeFromIso(job.created_at)}`}
                    </AppText>
                    {job.last_error ? (
                      <AppText variant="micro" style={{ color: colors.danger, letterSpacing: 0 }}>
                        {job.last_error}
                      </AppText>
                    ) : null}
                    {job.status === 'queued' || job.status === 'running' ? (
                      <Pressable onPress={() => void cloud.cancel(job.id)} hitSlop={8}>
                        <AppText variant="micro" style={{ color: colors.danger, marginTop: 2 }}>
                          CANCEL
                        </AppText>
                      </Pressable>
                    ) : null}
                  </View>
                ))
              )}
            </Panel>
          </FadeInView>

          <FadeInView delay={180} style={{ marginTop: spacing.xxl }}>
            <SectionHeader label="Activity" />
            <Panel padded={false}>
              {cloud.events.length === 0 ? (
                <View style={{ padding: spacing.lg }}>
                  <EmptyState
                    compact
                    icon="document-text-outline"
                    title="No events logged"
                    body="Every worker action writes an event here. Nothing is written unless something really ran."
                  />
                </View>
              ) : (
                cloud.events.map((event, index) => (
                  <View
                    key={String(event.id)}
                    style={{
                      paddingHorizontal: spacing.lg,
                      paddingVertical: spacing.md,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: colors.hairline,
                      gap: 2,
                    }}
                  >
                    <View
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: spacing.sm,
                      }}
                    >
                      <AppText variant="micro" style={{ letterSpacing: 1, color: colors.textMuted }}>
                        {event.kind.toUpperCase()}
                      </AppText>
                      <AppText variant="micro">{relativeFromIso(event.created_at)}</AppText>
                    </View>
                    <AppText
                      variant="caption"
                      style={{
                        color:
                          event.level === 'error'
                            ? colors.danger
                            : event.level === 'warn'
                              ? colors.amber
                              : colors.text,
                      }}
                    >
                      {event.message}
                    </AppText>
                  </View>
                ))
              )}
            </Panel>
          </FadeInView>
        </>
      ) : null}

      <AppText variant="micro" align="center" style={{ marginTop: spacing.xxl }}>
        NOVA OS · CLOUD FOUNDATION · PHASE ONE
      </AppText>
    </Screen>
  );
}

function StatBlock({ value, label, accent }: { value: string; label: string; accent: string }) {
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: 'rgba(10, 14, 28, 0.9)',
        gap: 2,
      }}
    >
      <AppText variant="title" color={accent} style={{ fontSize: 22, lineHeight: 26 }}>
        {value}
      </AppText>
      <AppText variant="micro" style={{ letterSpacing: 1 }}>
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}
