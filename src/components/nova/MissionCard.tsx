import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { Panel } from '@/components/ui/Panel';
import { colors, radius, spacing } from '@/theme';
import { getAgent } from '@/data/agents';
import { formatRelative } from '@/lib/time';
import type { Mission, MissionStatus } from '@/types/nova';

export const MISSION_STATUS_META: Record<MissionStatus, { label: string; color: string }> = {
  queued: { label: 'Queued', color: colors.cyan },
  active: { label: 'Active', color: colors.violetBright },
  complete: { label: 'Complete', color: colors.success },
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
  const agent = getAgent(mission.agentId);
  const status = MISSION_STATUS_META[mission.status];
  const isComplete = mission.status === 'complete';
  const delivered = Boolean(mission.result);

  const body = (
    <View style={{ flexDirection: 'row', gap: spacing.md }}>
      <Pressable
        onPress={onAdvance}
        hitSlop={10}
        accessibilityRole="button"
        accessibilityLabel={`Mission status: ${status.label}. Tap to advance.`}
        style={{
          width: 24,
          height: 24,
          borderRadius: radius.pill,
          borderWidth: 1.5,
          borderColor: status.color,
          backgroundColor: isComplete ? status.color : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
          marginTop: 2,
        }}
      >
        {isComplete ? (
          <Ionicons name="checkmark" size={13} color={colors.bg} />
        ) : mission.status === 'active' ? (
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status.color }} />
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
              {agent.name}
            </AppText>
          </View>
          {projectName ? (
            <AppText variant="micro" numberOfLines={1} style={{ maxWidth: 120 }}>
              {projectName.toUpperCase()}
            </AppText>
          ) : null}
          <AppText variant="micro">{status.label.toUpperCase()}</AppText>
          {delivered ? (
            <AppText variant="micro" style={{ color: colors.success }}>
              DELIVERED
            </AppText>
          ) : null}
          <AppText variant="micro">{formatRelative(mission.createdAt)}</AppText>
        </View>
      </View>

      <View style={{ alignItems: 'center', gap: spacing.md }}>
        {onRun && !delivered ? (
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
      accent={delivered ? colors.success : undefined}
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
