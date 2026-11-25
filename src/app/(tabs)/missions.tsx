import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { Screen } from '@/components/ui/Screen';
import { AppText } from '@/components/ui/AppText';
import { Chip, StatTile } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { FormField } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { MissionCard } from '@/components/nova/MissionCard';
import { getAgent } from '@/data/agents';
import { isMissionOpen } from '@/lib/mission';
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';
import type { Mission, MissionRunMode } from '@/types/nova';

type Filter = 'all' | 'running' | 'approval' | 'done' | 'failed';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'approval', label: 'Needs you' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' },
];

function matchesFilter(mission: Mission, filter: Filter): boolean {
  switch (filter) {
    case 'running':
      return (
        mission.status === 'planning' ||
        mission.status === 'active' ||
        mission.status === 'reviewing'
      );
    case 'approval':
      return mission.approval?.status === 'pending' || mission.status === 'awaiting_approval';
    case 'done':
      return mission.status === 'complete';
    case 'failed':
      return mission.status === 'failed';
    default:
      return true;
  }
}

export default function MissionsScreen() {
  const router = useRouter();
  const { missions, projects, advanceMission, deleteMission, createMission } = useNova();
  const runtime = useAgentRuntime();

  const [goal, setGoal] = useState('');
  const [mode, setMode] = useState<MissionRunMode>('review');
  const [filter, setFilter] = useState<Filter>('all');

  const approvals = missions.filter((mission) => mission.approval?.status === 'pending');
  const running = missions.filter(
    (mission) =>
      mission.status === 'planning' ||
      mission.status === 'active' ||
      mission.status === 'reviewing',
  );
  const done = missions.filter((mission) => mission.status === 'complete');
  const open = missions.filter(isMissionOpen);

  const queue = missions
    .flatMap((mission) =>
      mission.tasks
        .filter((task) => task.status === 'queued')
        .map((task) => ({ mission, task })),
    )
    .slice(0, 4);

  const visible = useMemo(
    () => missions.filter((mission) => matchesFilter(mission, filter)),
    [filter, missions],
  );

  const countFor = (key: Filter) => missions.filter((mission) => matchesFilter(mission, key)).length;

  const startGoal = () => {
    const text = goal.trim();
    if (!text || !runtime.hasKey) return;

    const mission = createMission({
      title: text.split('\n')[0].slice(0, 90),
      objective: text,
      agentId: 'nova',
      kind: 'planned',
      mode,
    });

    setGoal('');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    router.push(`/mission/${mission.id}`);

    // Let the store commit before the runtime reads the mission back.
    setTimeout(() => {
      void runtime.runMission(mission.id);
    }, 250);
  };

  const handleRun = async (mission: Mission) => {
    const result = await runtime.runMission(mission.id);
    if (!result.ok) {
      Alert.alert('Mission stopped', result.error ?? 'Unknown error');
    }
  };

  const handleDelete = (mission: Mission) => {
    Alert.alert('Delete mission?', `"${mission.title}" and its history will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMission(mission) },
    ]);
  };

  const handleApprove = async (mission: Mission) => {
    const result = await runtime.approveMission(mission.id);
    if (!result.ok) {
      Alert.alert('Could not continue', result.error ?? 'Unknown error');
    }
  };

  const handleReject = (mission: Mission) => {
    Alert.alert('Cancel this mission?', 'Execution stops and the plan is kept for reference.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Cancel mission',
        style: 'destructive',
        onPress: () => {
          void runtime.rejectMission(mission.id);
        },
      },
    ]);
  };

  return (
    <Screen
      eyebrow="Operations"
      title="Mission control"
      subtitle="Goals in, plans out. NOVA delegates, reviews and reports."
      right={
        <IconButton
          icon="add"
          label="Create mission"
          onPress={() => router.push('/mission-new')}
        />
      }
    >
      <FadeInView>
        <Panel accent={colors.violet} style={{ gap: spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Ionicons name="flag-outline" size={14} color={colors.violetBright} />
            <AppText variant="label">NEW GOAL</AppText>
          </View>

          <FormField
            label="What should NOVA achieve?"
            placeholder="Describe the outcome, not the steps. e.g. Launch the pricing page with copy, a revenue model and a QA pass."
            value={goal}
            onChangeText={setGoal}
            multiline
            maxLength={600}
          />

          <View style={{ gap: spacing.sm }}>
            <AppText variant="label">PLAN APPROVAL</AppText>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              <Chip
                label="Review plan first"
                active={mode === 'review'}
                onPress={() => setMode('review')}
              />
              <Chip
                label="Auto-run"
                active={mode === 'auto'}
                color={colors.emerald}
                onPress={() => setMode('auto')}
              />
            </View>
          </View>

          <NeonButton
            label="Plan with NOVA"
            icon="sparkles"
            onPress={startGoal}
            disabled={!goal.trim() || !runtime.hasKey}
          />

          <AppText variant="micro" style={{ lineHeight: 16 }}>
            {runtime.hasKey
              ? 'PLAN IS CAPPED AT 5 TASKS, 2 ATTEMPTS EACH AND 24 MODEL CALLS.'
              : 'CORE OFFLINE · ADD YOUR NVIDIA KEY IN CORE SETTINGS TO PLAN AND RUN.'}
          </AppText>
        </Panel>
      </FadeInView>

      <FadeInView delay={60}>
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }}>
          <StatTile value={String(running.length)} label="Running" accent={colors.violetBright} />
          <StatTile value={String(approvals.length)} label="Needs you" accent={colors.amber} />
          <StatTile value={String(done.length)} label="Delivered" accent={colors.emerald} />
        </View>
      </FadeInView>

      {approvals.length > 0 ? (
        <FadeInView delay={100} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label="Waiting for your approval" />
          <View style={{ gap: spacing.sm }}>
            {approvals.map((mission) => {
              const approval = mission.approval;
              if (!approval) return null;
              const approveLabel =
                approval.kind === 'plan'
                  ? 'Approve & run'
                  : approval.taskId
                    ? 'Accept failure & continue'
                    : 'Resume run';

              return (
                <Panel key={mission.id} accent={colors.amber} style={{ gap: spacing.sm }}>
                  <AppText variant="bodyStrong" style={{ fontSize: 13 }}>
                    {mission.title}
                  </AppText>
                  <AppText variant="caption">{approval.note}</AppText>
                  <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs }}>
                    <View style={{ flex: 1 }}>
                      <NeonButton
                        label={approveLabel}
                        icon="checkmark-circle-outline"
                        onPress={() => {
                          void handleApprove(mission);
                        }}
                        disabled={!runtime.hasKey}
                      />
                    </View>
                    <View style={{ flex: 1 }}>
                      <NeonButton
                        label="Cancel"
                        icon="close-circle-outline"
                        variant="danger"
                        onPress={() => handleReject(mission)}
                      />
                    </View>
                  </View>
                  <AppText
                    variant="micro"
                    style={{ color: colors.cyan }}
                    onPress={() => router.push(`/mission/${mission.id}`)}
                  >
                    OPEN MISSION
                  </AppText>
                </Panel>
              );
            })}
          </View>
        </FadeInView>
      ) : null}

      {queue.length > 0 ? (
        <FadeInView delay={140} style={{ marginTop: spacing.xxl }}>
          <SectionHeader label={`Task queue · ${queue.length}`} />
          <Panel padded={false}>
            {queue.map((entry, index) => {
              const agent = getAgent(entry.task.agentId);
              return (
                <View
                  key={entry.task.id}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.sm,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: colors.hairline,
                  }}
                >
                  <View
                    style={{
                      width: 6,
                      height: 6,
                      borderRadius: 3,
                      backgroundColor: agent.accent,
                    }}
                  />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodyStrong" numberOfLines={1} style={{ fontSize: 12.5 }}>
                      {entry.task.title}
                    </AppText>
                    <AppText variant="micro" numberOfLines={1}>
                      {agent.name} · {entry.mission.title}
                    </AppText>
                  </View>
                  <AppText variant="micro">
                    {entry.task.attempt > 0 ? `TRY ${entry.task.attempt + 1}` : 'QUEUED'}
                  </AppText>
                </View>
              );
            })}
          </Panel>
        </FadeInView>
      ) : null}

      <FadeInView delay={180} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Missions" actionLabel={`${open.length} open`} />
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingBottom: spacing.md }}
        >
          {FILTERS.map((item) => (
            <Chip
              key={item.key}
              label={`${item.label} ${countFor(item.key)}`}
              active={filter === item.key}
              color={item.key === 'done' ? colors.emerald : item.key === 'approval' ? colors.amber : colors.violet}
              onPress={() => setFilter(item.key)}
            />
          ))}
        </ScrollView>

        <View style={{ gap: spacing.sm }}>
          {visible.length === 0 ? (
            <EmptyState
              icon="compass-outline"
              title={missions.length === 0 ? 'No missions yet' : 'Nothing in this view'}
              body={
                missions.length === 0
                  ? 'Describe a goal above and NOVA will break it into tasks, delegate them and report back.'
                  : 'No mission matches this filter. Switch back to All to see everything.'
              }
            />
          ) : (
            visible.map((mission, index) => (
              <FadeInView key={mission.id} delay={Math.min(index * 40, 200)}>
                <MissionCard
                  mission={mission}
                  projectName={projects.find((project) => project.id === mission.projectId)?.name}
                  onOpen={() => router.push(`/mission/${mission.id}`)}
                  onRun={() => {
                    void handleRun(mission);
                  }}
                  isRunning={runtime.isBusy(`mission:${mission.id}`)}
                  onAdvance={() => advanceMission(mission)}
                  onDelete={() => handleDelete(mission)}
                />
              </FadeInView>
            ))
          )}
        </View>
      </FadeInView>

      <View
        style={{
          flexDirection: 'row',
          gap: 6,
          marginTop: spacing.xl,
          paddingHorizontal: spacing.sm,
        }}
      >
        <Ionicons name="shield-checkmark-outline" size={12} color={colors.textDim} />
        <AppText variant="micro" style={{ flex: 1, lineHeight: 16 }}>
          EVERY TASK IS A REAL MODEL CALL. RUNS STOP AT 5 TASKS, 2 ATTEMPTS PER TASK, 24 CALLS AND
          AN 8 MINUTE WINDOW, SO NOTHING CAN LOOP FOREVER.
        </AppText>
      </View>
    </Screen>
  );
}
