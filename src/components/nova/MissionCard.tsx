import React from 'react';
import { Pressable, View } from 'react-native';
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
  onAdvance: () => void;
  onDelete: () => void;
}

export function MissionCard({ mission, projectName, onAdvance, onDelete }: MissionCardProps) {
  const agent = getAgent(mission.agentId);
  const status = MISSION_STATUS_META[mission.status];
  const isComplete = mission.status === 'complete';

  return (
    <Panel padded={false} style={{ padding: spacing.lg }} accent={isComplete ? colors.success : undefined}>
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
            <View
              style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: status.color }}
            />
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

          {mission.objective ? (
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
            <AppText variant="micro">{formatRelative(mission.createdAt)}</AppText>
          </View>
        </View>

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
    </Panel>
  );
}
