import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { Panel } from '@/components/ui/Panel';
import { StatusPill } from '@/components/ui/Bits';
import { colors, radius, spacing } from '@/theme';
import type { Agent } from '@/types/nova';

interface AgentCardProps {
  agent: Agent;
  activeMissions?: number;
  onPress?: () => void;
  compact?: boolean;
}

export function AgentCard({ agent, activeMissions = 0, onPress, compact }: AgentCardProps) {
  const workload =
    activeMissions > 0 ? { label: `${activeMissions} active`, color: agent.accent } : { label: 'Ready', color: colors.textDim };

  return (
    <Panel onPress={onPress} accent={agent.accent} style={{ padding: spacing.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
        <View
          style={{
            width: 42,
            height: 42,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: `${agent.accent}55`,
            backgroundColor: `${agent.accent}14`,
            alignItems: 'center',
            justifyContent: 'center',
            shadowColor: agent.accent,
            shadowOpacity: 0.4,
            shadowRadius: 12,
            shadowOffset: { width: 0, height: 0 },
          }}
        >
          <Ionicons name={agent.icon} size={19} color={agent.accent} />
        </View>

        <View style={{ flex: 1 }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: spacing.sm,
            }}
          >
            <AppText variant="heading">{agent.name}</AppText>
            <StatusPill label={workload.label} color={workload.color} />
          </View>
          <AppText variant="micro" style={{ color: agent.accent, marginTop: 3, letterSpacing: 1.3 }}>
            {agent.role.toUpperCase()}
          </AppText>
          {!compact ? (
            <AppText variant="caption" numberOfLines={2} style={{ marginTop: spacing.sm }}>
              {agent.tagline}
            </AppText>
          ) : null}
        </View>

        {onPress ? <Ionicons name="chevron-forward" size={15} color={colors.textDim} /> : null}
      </View>
    </Panel>
  );
}
