import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { Panel } from '@/components/ui/Panel';
import { colors, radius, spacing } from '@/theme';
import { getAgent } from '@/data/agents';
import { getMissionProgress } from '@/lib/mission';
import { formatRelative } from '@/lib/time';
import type { Mission, MissionStatus, MissionTaskStatus } from '@/types/nova';

export const MISSION_STATUS_META: Record<MissionStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: colors.cyan },
  planning: { label: 'Planning', color: colors.violetBright },
  awaiting_approval: { label: 'Needs you', color: colors.amber },
  active: { label: 'Running', color: colors.violetBright },
  reviewing: { label: 'Reviewing', color: colors.blue },
  complete: { label: 'Complete', color: colors.success },
  failed: { label: 'Failed', color: colors.danger },
  cancelled: { label: 'Cancelled', color: colors.textDim },
};

export const TASK_STATUS_META: Record<MissionTaskStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: colors.cyan },
  running: { label: 'Running', color: colors.violetBright },
  review: { label: 'Review', color: colors.blue },
  complete: { label: 'Done', color: colors.success },
  failed: { label: 'Failed', color: colors.danger },
  blocked: { label: 'Blocked', color: colors.amber },
};

interface MissionCardProps {
  mission: Mission;
  projectName?: string;
  onOpen?: () => void;
  onRun?: () => void;
  onAdvance?: () => void;
  onDelete: () => void;
  isRunning?: boolean;
}

export function MissionCard({
  mission,
  projectName,
  onOpen,
  onRun,
  onAdvance,
  onDelete,
  isRunning,
}: MissionCardProps) {
  const planned = mission.kind === 'planned';
  const agent = getAgent(planned ? 'nova' : mission.agentId);
  const pending = mission.approval?.status === 'pending';
  const meta = pending
    ? { label: 'Needs you', color: colors.amber }
    : MISSION_STATUS_META[mission.status];
  const isComplete = mission.status === 'complete';
  const terminal =
    mission.status === 'complete' ||
    mission.status === 'failed' ||
    mission.status === 'cancelled';
  const delivered = Boolean(mission.result);
  const progress = getMissionProgress(mission);

  const body = (
    <View style={{ flexDirection: 'row', gap: spacing.md }}>
      <Pressable
        onPress={onAdvance}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Mission status: ${meta.label}. Tap to advance.`}
        style={{
          width: 24,
          height: 24,
          borderRadius: radius.pill,
          borderWidth: 1.5,
          borderColor: meta.color,
          backgroundColor: isComplete ? meta.color : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        {isComplete ? (
          <Ionicons name="checkmark" size={13} color={colors.bg} />
        ) : mission.status === 'active' || mission.status === 'planning' ? (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: meta.color }} />
        ) : null}
      </Pressable>

      <View style={{ flex: 1 }}>
        <AppText
          variant="bodyStrong"
          style={{
            textDecorationLine: isComplete ? 'line-through' : 'none',
            color: isComplete ? colors.textMuted : colors.text,
          }}
        >
          {mission.title}
        </AppText>

        {delivered && mission.result ? (
          <AppText variant="caption" numberOfLines={2} style={{ marginTop: 4 }}>
            {mission.result.text}
          </AppText>
        ) : mission.objective ? (
          <AppText variant="caption" numberOfLines={2} style={{ marginTop: 4 }}>
            {mission.objective}
          </AppText>
        ) : null}

        {planned && progress.total > 0 ? (
          <View style={{ marginTop: spacing.sm, gap: 5 }}>
            <View
              style={{
                height: 4,
                borderRadius: 2,
                backgroundColor: 'rgba(255,255,255,0.07)',
                overflow: 'hidden',
              }}
            >
              <View
                style={{
                  width: `${progress.percent}%`,
                  height: '100%',
                  borderRadius: 2,
                  backgroundColor: progress.failed > 0 ? colors.amber : agent.accent,
                }}
              />
            </View>
            <AppText variant="micro">
              {progress.complete}/{progress.total} TASKS · {progress.percent}%
              {progress.failed > 0 ? ` · ${progress.failed} FAILED` : ''}
            </AppText>
          </View>
        ) : null}

        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: spacing.sm,
            marginTop: spacing.sm,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
            <Ionicons name={agent.icon} size={11} color={agent.accent} />
            <AppText variant="micro" style={{ color: agent.accent }}>
              {planned ? 'NOVA PLAN' : agent.name}
            </AppText>
          </View>
          {projectName ? (
            <AppText variant="micro" numberOfLines={1} style={{ maxWidth: 120 }}>
              {projectName.toUpperCase()}
            </AppText>
          ) : null}
          <AppText variant="micro" style={{ color: meta.color }}>
            {meta.label.toUpperCase()}
          </AppText>
          {pending ? (
            <AppText variant="micro" style={{ color: colors.amber }}>
              APPROVAL NEEDED
            </AppText>
          ) : null}
          {delivered ? (
            <AppText variant="micro" style={{ color: colors.success }}>
              DELIVERED
            </AppText>
          ) : null}
          <AppText variant="micro">{formatRelative(mission.createdAt)}</AppText>
        </View>
      </View>

      <View style={{ alignItems: 'center', gap: spacing.md }}>
        {onRun && !terminal && !pending ? (
          <Pressable
            onPress={onRun}
            disabled={isRunning}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={`Run mission ${mission.title}`}
            style={({ pressed }) => ({ opacity: pressed || isRunning ? 0.5 : 1 })}
          >
            {isRunning ? (
              <ActivityIndicator size="small" color={agent.accent} />
            ) : (
              <Ionicons name="play-circle-outline" size={24} color={agent.accent} />
            )}
          </Pressable>
        ) : null}

        <Pressable
          onPress={onDelete}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Delete mission ${mission.title}`}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Ionicons name="trash-outline" size={16} color={colors.textDim} />
        </Pressable>
      </View>
    </View>
  );

  return (
    <Panel
      padded={false}
      style={{ padding: spacing.lg }}
      accent={pending ? colors.amber : delivered ? colors.success : undefined}
    >
      {onOpen ? (
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`Open mission ${mission.title}`}
          style={({ pressed }) => ({ opacity: pressed ? 0.85 : 1 })}
        >
          {body}
        </Pressable>
      ) : (
        body
      )}
    </Panel>
  );
}
