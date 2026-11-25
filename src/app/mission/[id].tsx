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
import {
  MISSION_STATUS_META,
  TASK_STATUS_META,
} from '@/components/nova/MissionCard';
import { getAgent } from '@/data/agents';
import { getMissionProgress, MISSION_LIMITS } from '@/lib/mission';
import { formatRelative } from '@/lib/time';
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';
import type { MissionTask } from '@/types/nova';

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

function ProgressBar({ percent, color }: { percent: number; color: string }) {
  return (
    <View
      style={{
        height: 6,
        borderRadius: 3,
        backgroundColor: 'rgba(255,255,255,0.07)',
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${Math.max(2, percent)}%`,
          height: '100%',
          borderRadius: 3,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function TaskRow({
  task,
  index,
  total,
  onRetry,
  busy,
  canRetry,
}: {
  task: MissionTask;
  index: number;
  total: number;
  onRetry: () => void;
  busy: boolean;
  canRetry: boolean;
}) {
  const agent = getAgent(task.agentId);
  const meta = TASK_STATUS_META[task.status];

  return (
    <Panel
      padded={false}
      style={{ padding: spacing.md, gap: spacing.sm }}
      accent={task.status === 'blocked' || task.status === 'failed' ? colors.amber : undefined}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <AppText variant="micro">{String(index + 1).padStart(2, '0')}</AppText>
        <View style={{ flex: 1 }}>
          <AppText variant="bodyStrong" style={{ fontSize: 13 }}>
            {task.title}
          </AppText>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 3 }}>
            <Ionicons name={agent.icon} size={10} color={agent.accent} />
            <AppText variant="micro" style={{ color: agent.accent }}>
              {agent.name}
            </AppText>
            <AppText variant="micro">· {total > 0 ? `${index + 1}/${total}` : ''}</AppText>
          </View>
        </View>
        <View style={{ alignItems: 'flex-end', gap: 3 }}>
          <AppText variant="micro" style={{ color: meta.color }}>
            {meta.label.toUpperCase()}
          </AppText>
          <AppText variant="micro">
            TRY {task.attempt}/{task.maxAttempts}
          </AppText>
        </View>
      </View>

      <View
        style={{
          borderLeftWidth: 2,
          borderLeftColor: `${agent.accent}55`,
          paddingLeft: spacing.sm,
          gap: 4,
        }}
      >
        <AppText variant="micro" style={{ lineHeight: 15 }}>
          {task.brief.slice(0, 260).toUpperCase()}
        </AppText>
      </View>

      {task.output ? (
        <View style={{ gap: 4 }}>
          <AppText variant="micro" style={{ color: colors.success }}>
            OUTPUT
          </AppText>
          <AppText variant="caption" style={{ fontSize: 12, lineHeight: 18 }}>
            {task.output}
          </AppText>
        </View>
      ) : null}

      {task.error ? (
        <AppText variant="micro" style={{ color: colors.amber, lineHeight: 15 }}>
          {task.error.toUpperCase()}
        </AppText>
      ) : null}

      {task.review ? (
        <View style={{ gap: 3 }}>
          <AppText
            variant="micro"
            style={{ color: task.review.verdict === 'pass' ? colors.success : colors.amber }}
          >
            REVIEW · {task.review.verdict.toUpperCase()}
          </AppText>
          <AppText variant="micro" style={{ lineHeight: 15 }}>
            {task.review.notes.toUpperCase()}
          </AppText>
        </View>
      ) : null}

      {canRetry ? (
        <NeonButton
          label={busy ? 'Working…' : 'Retry this task'}
          icon="refresh"
          variant="ghost"
          onPress={onRetry}
          loading={busy}
        />
      ) : null}
    </Panel>
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

  const planned = mission.kind === 'planned';
  const agent = getAgent(planned ? 'nova' : mission.agentId);
  const project = projects.find((entry) => entry.id === mission.projectId);
  const running = runtime.isBusy(`mission:${mission.id}`);
  const pending = mission.approval?.status === 'pending';
  const progress = getMissionProgress(mission);
  const status = pending
    ? { label: 'Needs you', color: colors.amber }
    : MISSION_STATUS_META[mission.status];
  const terminal =
    mission.status === 'complete' ||
    mission.status === 'failed' ||
    mission.status === 'cancelled';

  const runAction = async () => {
    const result = await runtime.runMission(mission.id);
    if (!result.ok) {
      Alert.alert('Mission stopped', result.error ?? 'Unknown error');
    }
  };

  const approveAction = async () => {
    const result = await runtime.approveMission(mission.id);
    if (!result.ok) {
      Alert.alert('Could not continue', result.error ?? 'Unknown error');
    }
  };

  const cancelAction = () => {
    Alert.alert('Cancel this mission?', 'Execution stops. Completed work is kept.', [
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

  const retryTask = async (task: MissionTask) => {
    const result = await runtime.retryMissionTask(mission.id, task.id);
    if (!result.ok) {
      Alert.alert('Could not retry', result.error ?? 'Unknown error');
    }
  };

  const handleDelete = () => {
    Alert.alert('Delete mission?', `"${mission.title}" and its history will be removed.`, [
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

  const report = mission.report;
  const resultText = report?.text ?? mission.result?.text;

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <DetailHeader
          title={planned ? 'Planned mission' : 'Mission'}
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
          <Panel accent={agent.accent} style={{ gap: spacing.md }}>
            <AppText variant="title" style={{ fontSize: 22, lineHeight: 28 }}>
              {mission.title}
            </AppText>

            <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                <Ionicons name={agent.icon} size={12} color={agent.accent} />
                <AppText variant="micro" style={{ color: agent.accent }}>
                  {planned ? 'NOVA COORDINATES' : agent.name}
                </AppText>
              </View>
              {project ? <Chip label={project.name} color={project.accent} /> : null}
              <Chip label={planned ? 'Planned' : 'Single agent'} color={colors.violet} />
              <AppText variant="micro">{formatRelative(mission.createdAt).toUpperCase()}</AppText>
            </View>

            {mission.objective ? (
              <AppText variant="caption" style={{ lineHeight: 19 }}>
                {mission.objective}
              </AppText>
            ) : null}

            {planned ? (
              <View style={{ gap: spacing.sm }}>
                <ProgressBar
                  percent={progress.percent}
                  color={progress.failed > 0 ? colors.amber : agent.accent}
                />
                <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                  <AppText variant="micro">
                    {progress.complete}/{progress.total} TASKS · {progress.percent}%
                  </AppText>
                  <AppText variant="micro">
                    {progress.running > 0
                      ? `${progress.running} ACTIVE`
                      : progress.queued > 0
                        ? `${progress.queued} QUEUED`
                        : progress.failed > 0
                          ? `${progress.failed} FAILED`
                          : 'PLAN COMPLETE'}
                  </AppText>
                </View>
              </View>
            ) : null}
          </Panel>

          {pending && mission.approval ? (
            <Panel accent={colors.amber} style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Ionicons name="hand-left-outline" size={15} color={colors.amber} />
                <AppText variant="bodyStrong" style={{ fontSize: 13, color: colors.amber }}>
                  {mission.approval.kind === 'plan' ? 'PLAN NEEDS APPROVAL' : 'RUN NEEDS DECISION'}
                </AppText>
              </View>
              <AppText variant="caption">{mission.approval.note}</AppText>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <View style={{ flex: 1 }}>
                  <NeonButton
                    label={
                      mission.approval.kind === 'plan'
                        ? 'Approve & run'
                        : mission.approval.taskId
                          ? 'Accept failure & continue'
                          : 'Resume run'
                    }
                    icon="checkmark-circle-outline"
                    onPress={() => {
                      void approveAction();
                    }}
                    disabled={!runtime.hasKey || running}
                    loading={running}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <NeonButton
                    label="Cancel mission"
                    icon="close-circle-outline"
                    variant="danger"
                    onPress={cancelAction}
                  />
                </View>
              </View>
            </Panel>
          ) : null}

          <View style={{ gap: spacing.sm }}>
            {planned ? (
              <NeonButton
                label={
                  running
                    ? 'NOVA is executing the plan…'
                    : mission.tasks.length === 0
                      ? 'Plan this goal with NOVA'
                      : terminal
                        ? 'Run again from the current plan'
                        : 'Continue execution'
                }
                icon={mission.tasks.length === 0 ? 'sparkles' : 'play'}
                onPress={() => {
                  void runAction();
                }}
                loading={running}
                disabled={running || !runtime.hasKey || pending || mission.status === 'cancelled'}
              />
            ) : (
              <>
                <NeonButton
                  label={
                    running
                      ? `${agent.name} is working…`
                      : mission.result
                        ? `Run again with ${agent.name}`
                        : `Run with ${agent.name}`
                  }
                  icon={mission.result ? 'refresh' : 'play'}
                  onPress={() => {
                    void runAction();
                  }}
                  loading={running}
                  disabled={running || !runtime.hasKey}
                />
                <NeonButton
                  label="Mark complete without running"
                  icon="checkmark-done-outline"
                  variant="ghost"
                  onPress={handleMarkComplete}
                  disabled={mission.status === 'complete'}
                />
              </>
            )}

            {!runtime.hasKey ? (
              <AppText variant="micro" align="center" style={{ color: colors.amber }}>
                CORE OFFLINE · ADD YOUR NVIDIA KEY IN CORE SETTINGS
              </AppText>
            ) : null}
          </View>

          {planned ? (
            <View>
              <SectionHeader
                label={`Plan · ${mission.tasks.length}/${MISSION_LIMITS.maxTasks}`}
                actionLabel={mission.planModel ? mission.planModel.split('/')[1]?.toUpperCase() : undefined}
              />
              {mission.tasks.length === 0 ? (
                <Panel>
                  <AppText variant="caption">
                    {running
                      ? 'NOVA is decomposing this goal into tasks now.'
                      : 'No plan yet. Run the mission and NOVA will break the goal into up to 5 delegated tasks.'}
                  </AppText>
                </Panel>
              ) : (
                <View style={{ gap: spacing.sm }}>
                  {mission.tasks.map((task, index) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      index={index}
                      total={mission.tasks.length}
                      onRetry={() => {
                        void retryTask(task);
                      }}
                      busy={running}
                      canRetry={
                        !running &&
                        !pending &&
                        (task.status === 'blocked' ||
                          task.status === 'failed' ||
                          task.status === 'queued' ||
                          task.status === 'complete')
                      }
                    />
                  ))}
                </View>
              )}
            </View>
          ) : null}

          <View>
            <SectionHeader label={planned ? 'Final report' : 'Result'} />
            {resultText ? (
              <Panel accent={colors.success} style={{ gap: spacing.md }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Ionicons
                    name={report ? 'document-text-outline' : 'checkmark-circle'}
                    size={16}
                    color={report ? colors.violetBright : colors.success}
                  />
                  <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13 }}>
                    {report
                      ? `${report.completed}/${report.completed + report.failed} tasks delivered`
                      : `Delivered by ${getAgent(mission.result?.agentId ?? 'nova').name}`}
                  </AppText>
                  {report ? (
                    <AppText variant="micro">
                      {Math.max(1, Math.round(report.durationMs / 1000))}S
                    </AppText>
                  ) : mission.result ? (
                    <AppText variant="micro">
                      {Math.max(1, Math.round(mission.result.durationMs / 1000))}S
                    </AppText>
                  ) : null}
                </View>

                <AppText variant="body" style={{ lineHeight: 21 }}>
                  {resultText}
                </AppText>

                <View
                  style={{
                    borderTopWidth: 1,
                    borderTopColor: colors.hairline,
                    paddingTop: spacing.sm,
                    gap: 4,
                  }}
                >
                  <AppText variant="micro">
                    MODEL · {report?.model ?? mission.result?.model ?? 'unknown'}
                  </AppText>
                  {mission.result?.steps.length ? (
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
                    {planned
                      ? 'No report yet. NOVA writes one after every task is resolved.'
                      : mission.status === 'active'
                        ? `${agent.name} started this mission. If no result appears, the run failed — check the activity log or run it again.`
                        : 'No work has been produced yet. Run the mission to get a real result.'}
                  </AppText>
                </View>
              </Panel>
            )}
          </View>

          <View>
            <SectionHeader label="Limits and usage" />
            <Panel>
              <InfoRow
                label="Model calls"
                value={`${mission.budget.callsUsed} / ${mission.budget.maxCalls}`}
                color={mission.budget.callsUsed >= mission.budget.maxCalls ? colors.amber : colors.text}
              />
              <InfoRow
                label="Tasks"
                value={`${mission.tasks.length} / ${mission.budget.maxTasks}`}
              />
              <InfoRow
                label="Attempts per task"
                value={String(mission.budget.maxAttempts)}
              />
              <InfoRow label="Execution mode" value={planned ? 'Planned by NOVA' : 'Single agent'} />
              <InfoRow
                label="Approval"
                value={
                  mission.approval
                    ? `${mission.approval.kind.toUpperCase()} · ${mission.approval.status.toUpperCase()}`
                    : 'Not required'
                }
              />
              <InfoRow label="Created" value={formatRelative(mission.createdAt)} />
              <InfoRow label="Updated" value={formatRelative(mission.updatedAt)} />
            </Panel>
          </View>

          {mission.history.length > 0 ? (
            <View>
              <SectionHeader label="Execution history" />
              <Panel>
                {mission.history.slice(0, 24).map((event, index) => (
                  <View
                    key={event.id}
                    style={{
                      flexDirection: 'row',
                      gap: spacing.sm,
                      paddingVertical: spacing.sm,
                      borderTopWidth: index === 0 ? 0 : 1,
                      borderTopColor: colors.hairline,
                    }}
                  >
                    <View
                      style={{
                        width: 5,
                        height: 5,
                        borderRadius: 3,
                        backgroundColor: colors.violetBright,
                        marginTop: 6,
                      }}
                    />
                    <View style={{ flex: 1 }}>
                      <AppText variant="bodyStrong" style={{ fontSize: 12.5 }}>
                        {event.label}
                      </AppText>
                      {event.detail ? (
                        <AppText variant="micro" style={{ lineHeight: 15 }}>
                          {event.detail}
                        </AppText>
                      ) : null}
                    </View>
                    <AppText variant="micro">{formatRelative(event.createdAt).toUpperCase()}</AppText>
                  </View>
                ))}
              </Panel>
            </View>
          ) : null}

          <View style={{ gap: spacing.sm }}>
            {planned ? null : (
              <NeonButton
                label={`Open ${agent.name}`}
                icon="person-circle-outline"
                variant="ghost"
                onPress={() => router.push(`/agent/${agent.id}`)}
              />
            )}
            {!terminal ? (
              <NeonButton
                label="Cancel mission"
                icon="stop-circle-outline"
                variant="ghost"
                onPress={cancelAction}
              />
            ) : null}
            <NeonButton
              label="Delete mission"
              icon="trash-outline"
              variant="danger"
              onPress={handleDelete}
            />
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: spacing.sm }}>
            <Ionicons name="shield-checkmark-outline" size={12} color={colors.textDim} />
            <AppText variant="micro" style={{ flex: 1, letterSpacing: 0.6, lineHeight: 16 }}>
              RESULTS ARE MODEL OUTPUT, STORED ON THIS DEVICE. VERIFY BEFORE ACTING.
            </AppText>
          </View>

          <View style={{ height: radius.sm }} />
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
