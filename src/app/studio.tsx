import React, { useCallback, useEffect, useState } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusDot } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Screen } from '@/components/ui/Screen';
import {
  describeCloudError,
  loadProductionFiles,
  loadProductionJobs,
  loadProductionQa,
  productionFileUrl,
  startProduction,
  updateCompanySettings,
} from '@/lib/cloud/api';
import { getSupabase } from '@/lib/cloud/client';
import {
  PRODUCTION_STATUS_LABEL,
  type CloudProductionFile,
  type CloudProductionJob,
  type CloudProductionQa,
  type ProductionStatus,
} from '@/lib/cloud/types';
import { formatRelative } from '@/lib/time';
import { useCloud } from '@/store/cloud-store';
import { colors, spacing } from '@/theme';

/**
 * Studio.
 *
 * A paid order becomes a production job automatically. FORGE writes real files,
 * SENTINEL checks the stored bytes, and a job only reads READY when a QA row
 * says pass. This screen shows the truth: attempts, versions, QA notes and the
 * files that actually exist. It never marks work finished.
 */

function statusTone(status: ProductionStatus): string {
  switch (status) {
    case 'ready':
      return colors.success;
    case 'delivered':
      return colors.emerald;
    case 'needs_attention':
      return colors.amber;
    case 'qa':
      return colors.cyan;
    case 'generating':
      return colors.violetBright;
    case 'cancelled':
      return colors.textDim;
    default:
      return colors.violetBright;
  }
}

function relativeFromIso(iso: string | null): string {
  if (!iso) return 'not yet';
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? formatRelative(parsed) : 'unknown';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

function FileRow({
  file,
  busy,
  onOpen,
}: {
  file: CloudProductionFile;
  busy: boolean;
  onOpen: () => void;
}) {
  return (
    <Pressable
      onPress={onOpen}
      disabled={busy}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.sm,
        paddingVertical: spacing.sm,
        opacity: busy ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <StatusDot color={file.kind === 'primary' ? colors.emerald : colors.cyan} size={4} />
      <AppText variant="caption" style={{ flex: 1 }} numberOfLines={1}>
        {file.name}
      </AppText>
      <AppText variant="micro" style={{ letterSpacing: 0.3 }}>
        {humanSize(file.bytes)}
      </AppText>
      <AppText variant="micro" style={{ color: colors.violetBright, letterSpacing: 0.3 }}>
        OPEN
      </AppText>
    </Pressable>
  );
}

export default function StudioScreen() {
  const router = useRouter();
  const cloud = useCloud();
  const client = getSupabase();

  const [jobs, setJobs] = useState<CloudProductionJob[]>([]);
  const [files, setFiles] = useState<CloudProductionFile[]>([]);
  const [qa, setQa] = useState<CloudProductionQa[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const productionEnabled = cloud.health?.settings?.production_enabled ?? false;

  const refresh = useCallback(async () => {
    if (!client) return;
    setLoading(true);
    setError(null);
    try {
      const [nextJobs, nextFiles, nextQa] = await Promise.all([
        loadProductionJobs(client),
        loadProductionFiles(client),
        loadProductionQa(client),
      ]);
      setJobs(nextJobs);
      setFiles(nextFiles);
      setQa(nextQa);
    } catch (thrown) {
      setError(describeCloudError(thrown));
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    if (cloud.session) void refresh();
  }, [cloud.session, refresh]);

  const toggleProduction = async () => {
    if (!client) return;
    setBusy('settings');
    setError(null);
    try {
      await updateCompanySettings(client, { production_enabled: !productionEnabled });
      await cloud.refresh();
    } catch (thrown) {
      setError(describeCloudError(thrown));
    } finally {
      setBusy(null);
    }
  };

  const start = async (job: CloudProductionJob) => {
    if (!client) return;
    setBusy(job.id);
    setError(null);
    try {
      await startProduction(client, job.id);
      await refresh();
    } catch (thrown) {
      setError(describeCloudError(thrown));
    } finally {
      setBusy(null);
    }
  };

  const openFile = async (file: CloudProductionFile) => {
    if (!client) return;
    setBusy(file.id);
    setError(null);
    try {
      const url = await productionFileUrl(client, file.storage_path);
      await Linking.openURL(url);
    } catch (thrown) {
      setError(describeCloudError(thrown));
    } finally {
      setBusy(null);
    }
  };

  if (!cloud.session) {
    return (
      <Screen eyebrow="Nova OS" title="Studio" subtitle="Paid orders to real files.">
        <Panel accent={colors.amber}>
          <EmptyState
            icon="lock-closed-outline"
            title="Sign in to the cloud"
            body="Production runs on the worker, not on this phone. Sign in on the Cloud screen to see paid orders and generated files."
            actionLabel="Open cloud"
            onAction={() => router.push('/cloud')}
          />
        </Panel>
      </Screen>
    );
  }

  return (
    <Screen eyebrow="Nova OS" title="Studio" subtitle="Paid orders to real files.">
      <FadeInView>
        <Panel accent={productionEnabled ? colors.success : colors.amber}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={productionEnabled ? colors.success : colors.amber} size={7} />
            <AppText variant="heading">
              {productionEnabled ? 'PRODUCTION ARMED' : 'PRODUCTION OFF'}
            </AppText>
          </View>
          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {productionEnabled
              ? 'A paid order creates a job. FORGE writes real files, SENTINEL checks the stored bytes, and only a passing QA row makes a job ready.'
              : 'Paid orders still create a production job, but nothing is generated until you arm production.'}
          </AppText>

          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
            <View style={{ flex: 1 }}>
              <NeonButton
                label={productionEnabled ? 'Disarm production' : 'Arm production'}
                icon={productionEnabled ? 'pause-outline' : 'play-outline'}
                variant={productionEnabled ? 'ghost' : 'solid'}
                onPress={() => void toggleProduction()}
                loading={busy === 'settings'}
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

          {error ? (
            <AppText variant="caption" style={{ color: colors.amber, marginTop: spacing.md }}>
              {error}
            </AppText>
          ) : null}
        </Panel>
      </FadeInView>

      <FadeInView delay={30} style={{ marginTop: spacing.xxl }}>
        <SectionHeader
          label={`Jobs · ${jobs.length}`}
          actionLabel={loading ? 'Loading' : 'Refresh'}
          onAction={() => void refresh()}
        />
        <Panel padded={false}>
          {jobs.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <EmptyState
                compact
                icon="color-wand-outline"
                title="No production jobs yet"
                body="A job appears automatically when Stripe confirms a payment. It needs a paid order, not a promise."
              />
            </View>
          ) : (
            jobs.map((job) => {
              const jobFiles = files.filter(
                (file) => file.job_id === job.id && file.version === job.version,
              );
              const latestQa = qa.find(
                (row) => row.job_id === job.id && row.version === job.version,
              );
              const canStart = job.status === 'queued' || job.status === 'needs_attention';

              return (
                <View
                  key={job.id}
                  style={{
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    borderTopWidth: 1,
                    borderTopColor: colors.hairline,
                    gap: spacing.sm,
                  }}
                >
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <StatusDot color={statusTone(job.status)} size={6} />
                    <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13.5 }} numberOfLines={1}>
                      {job.title}
                    </AppText>
                    <AppText variant="micro" style={{ color: statusTone(job.status), letterSpacing: 0.5 }}>
                      {PRODUCTION_STATUS_LABEL[job.status]}
                    </AppText>
                  </View>

                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                    <Chip label={`v${job.version}`} color={colors.cyan} />
                    <Chip
                      label={`attempt ${job.attempts}/${job.max_attempts}`}
                      color={job.attempts >= job.max_attempts ? colors.amber : colors.violet}
                    />
                    {job.service_key ? <Chip label={job.service_key} color={colors.emerald} /> : null}
                    <Chip label={`created ${relativeFromIso(job.created_at)}`} color={colors.textDim} />
                  </View>

                  {job.qa_notes ? (
                    <AppText variant="caption" style={{ color: colors.amber }}>
                      QA: {job.qa_notes}
                    </AppText>
                  ) : null}

                  {jobFiles.length > 0 ? (
                    <View>
                      {jobFiles.map((file) => (
                        <FileRow
                          key={file.id}
                          file={file}
                          busy={busy === file.id}
                          onOpen={() => void openFile(file)}
                        />
                      ))}
                    </View>
                  ) : (
                    <AppText variant="caption">
                      No files stored for the current version yet.
                    </AppText>
                  )}

                  {latestQa ? (
                    <AppText variant="micro" style={{ letterSpacing: 0.3 }}>
                      {`SENTINEL ${latestQa.verdict.toUpperCase()} · ${relativeFromIso(latestQa.created_at)}`}
                    </AppText>
                  ) : null}

                  {canStart ? (
                    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                      <NeonButton
                        label={job.status === 'needs_attention' ? 'Retry production' : 'Start production'}
                        icon="color-wand-outline"
                        onPress={() => void start(job)}
                        loading={busy === job.id}
                        disabled={!productionEnabled || busy !== null}
                      />
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
        <Panel>
          <AppText variant="caption">
            Files live in the private `deliverables` bucket under the owner&apos;s folder. The links
            above are signed for one hour. SENTINEL checks that each file exists, has the right type
            and end marker (PDF), carries the business name and contains no unresolved template
            tokens. It does not open a browser, so a passing QA is not a substitute for the
            owner&apos;s own review before delivery.
          </AppText>
        </Panel>
      </FadeInView>
    </Screen>
  );
}
