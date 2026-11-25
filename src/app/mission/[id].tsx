import React from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusPill } from '@/components/ui/Bits';
import { DetailHeader } from '@/components/ui/DetailHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { MISSION_STATUS_META } from '@/components/nova/MissionCard';
import { getAgent } from '@/data/agents';
import { formatRelative } from '@/lib/time';
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';

function InfoRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: spacing.sm,
      }}
    >
      <AppText variant="micro" style={{ letterSpacing: 1 }}>
        {label.toUpperCase()}
      </AppText>
      <AppText variant="bodyStrong" style={{ fontSize: 13, color: color ?? colors.text }}>
        {value}
      </AppText>
    </View>
  );
}

export default function MissionScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { missions, projects, deleteMission, setMissionResult } = useNova();
  const runtime = useAgentRuntime();

  const mission = missions.find((entry) => entry.id === id);

  if (!mission) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
          <DetailHeader title="Mission" subtitle="Not found" />
          <View style={{ padding: spacing.xl }}>
            <EmptyState
              icon="compass-outline"
              title="Mission not found"
              body="It may have been deleted from this device."
              actionLabel="Back to missions"
              onAction={() => router.replace('/missions')}
            />
          </View>
        </SafeAreaView>
      </View>
    );
  }

  const agent = getAgent(mission.agentId);
  const status = MISSION_STATUS_META[mission.status];
  const project = projects.find((entry) => entry.id === mission.projectId);
  const running = runtime.isBusy(`mission:${mission.id}`);
  const enabled = runtime.hasKey;

  const handleRun = async () => {
    const result = await runtime.runMission(mission.id);

    if (!result.ok) {
      Alert.alert(`${agent.name} could not finish`, result.error ?? 'Unknown error');
    }
  };

  const handleDelete = () => {
    Alert.alert('Delete mission?', `"${mission.title}" will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteMission(mission);
          router.back();
        },
      },
    ]);
  };

  const handleMarkComplete = () => {
    setMissionResult(mission.id, {
      text: mission.result?.text ?? 'Marked complete manually. No model output was produced.',
      agentId: mission.agentId,
      model: mission.result?.model ?? 'manual',
      createdAt: Date.now(),
      durationMs: mission.result?.durationMs ?? 0,
      steps: mission.result?.steps ?? ['Marked complete by the owner'],
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <DetailHeader
          title="Mission"
          subtitle={agent.name}
          right={<StatusPill label={status.label} color={status.color} />}
        />

        <ScrollView
          contentContainerStyle={{
            padding: spacing.xl,
            paddingBottom: spacing.xxxl,
            gap: spacing.lg,
          }}
          showsVerticalScrollIndicator={false}
        >
          <Panel accent={agent.accent}>
            <AppText variant="title" style={{ fontSize: 22, lineHeight: 28 }}>
              {mission.title}
            </AppText>

            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: spacing.sm,
                marginTop: spacing.md,
              }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons name={agent.icon} size={12} color={agent.accent} />
                <AppText variant="micro" style={{ color: agent.accent }}>
                  {agent.name}
                </AppText>
              </View>
              {project ? <Chip label={project.name} color={project.accent} /> : null}
              <AppText variant="micro">{formatRelative(mission.createdAt).toUpperCase()}</AppText>
            </View>

            {mission.objective ? (
              <AppText variant="caption" style={{ marginTop: spacing.md, lineHeight: 19 }}>
                {mission.objective}
              </AppText>
            ) : null}
          </Panel>

          <View style={{ gap: spacing.sm }}>
            <NeonButton
              label={
                running
                  ? `${agent.name} is working…`
                  : mission.result
                    ? `Run again with ${agent.name}`
                    : `Run with ${agent.name}`
              }
              icon={mission.result ? 'refresh' : 'play'}
              onPress={handleRun}
              loading={running}
              disabled={running || !enabled}
            />
            {!enabled ? (
              <AppText variant="micro" align="center" style={{ color: colors.amber }}>
                CORE OFFLINE · ADD YOUR NVIDIA KEY IN CORE SETTINGS
              </AppText>
            ) : null}
            <NeonButton
              label="Mark complete without running"
              icon="checkmark-done-outline"
              variant="ghost"
              onPress={handleMarkComplete}
              disabled={mission.status === 'complete'}
            />
          </View>

          <View>
            <SectionHeader label="Result" />
            {mission.result ? (
              <Panel accent={colors.success} style={{ gap: spacing.md }}>
                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                  }}
                >
                  <Ionicons name="checkmark-circle" size={16} color={colors.success} />
                  <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13 }}>
                    Delivered by {getAgent(mission.result.agentId).name}
                  </AppText>
                  <AppText variant="micro">
                    {Math.max(1, Math.round(mission.result.durationMs / 1000))}S
                  </AppText>
                </View>

                <AppText variant="body" style={{ lineHeight: 21 }}>
                  {mission.result.text}
                </AppText>

                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: colors.hairline,
                    paddingTop: spacing.sm,
                  }}
                >
                  <AppText variant="micro">MODEL · {mission.result.model}</AppText>
                  {mission.result.steps.length > 0 ? (
                    <View style={{ marginTop: spacing.sm, gap: 4 }}>
                      {mission.result.steps.map((step, index) => (
                        <View
                          key={`${mission.id}-step-${index}`}
                          style={{ flexDirection: 'row', gap: spacing.sm }}
                        >
                          <AppText variant="micro" style={{ color: agent.accent }}>
                            ›
                          </AppText>
                          <AppText variant="caption" style={{ flex: 1, fontSize: 11.5 }}>
                            {step}
                          </AppText>
                        </View>
                      ))}
                    </View>
                  ) : null}
                </View>
              </Panel>
            ) : (
              <Panel>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <ActivityIndicator
                    size="small"
                    color={mission.status === 'active' ? agent.accent : colors.textDim}
                  />
                  <AppText variant="caption" style={{ flex: 1 }}>
                    {mission.status === 'active'
                      ? `${agent.name} started this mission. If no result appears, the run failed — check the activity log or run it again.`
                      : 'No work has been produced yet. Run the mission to get a real result.'}
                  </AppText>
                </View>
              </Panel>
            )}
          </View>

          <View>
            <SectionHeader label="Run details" />
            <Panel>
              <InfoRow label="Assigned agent" value={agent.name} color={agent.accent} />
              <InfoRow label="Role" value={agent.role} />
              <InfoRow label="Status" value={status.label} color={status.color} />
              <InfoRow label="Created" value={formatRelative(mission.createdAt)} />
              <InfoRow label="Updated" value={formatRelative(mission.updatedAt)} />
              {mission.startedAt ? (
                <InfoRow label="Last run" value={formatRelative(mission.startedAt)} />
              ) : null}
            </Panel>
          </View>

          <View style={{ gap: spacing.sm }}>
            <NeonButton
              label={`Open ${agent.name}`}
              icon="person-circle-outline"
              variant="ghost"
              onPress={() => router.push(`/agent/${agent.id}`)}
            />
            <NeonButton
              label="Delete mission"
              icon="trash-outline"
              variant="danger"
              onPress={handleDelete}
            />
          </View>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: spacing.sm,
            }}
          >
            <Ionicons name="shield-checkmark-outline" size={12} color={colors.textDim} />
            <AppText variant="micro" style={{ flex: 1, letterSpacing: 0.6 }}>
              RESULTS ARE MODEL OUTPUT, STORED ON THIS DEVICE. VERIFY BEFORE ACTING.
            </AppText>
          </View>

          <View style={{ height: radius.sm }} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
