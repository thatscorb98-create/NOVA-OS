import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { getAgent } from '@/data/agents';
import { colors, radius, spacing } from '@/theme';
import { formatClock } from '@/lib/time';
import type { Message } from '@/types/nova';

export function MessageBubble({ message }: { message: Message }) {
  if (message.role === 'system') {
    return (
      <View
        style={{
          alignSelf: 'center',
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: spacing.sm,
          maxWidth: '92%',
          paddingVertical: spacing.sm + 2,
          paddingHorizontal: spacing.md,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: colors.hairline,
          backgroundColor: 'rgba(255, 255, 255, 0.025)',
        }}
      >
        <Ionicons
          name="information-circle-outline"
          size={14}
          color={colors.textDim}
          style={{ marginTop: 1 }}
        />
        <AppText variant="caption" style={{ flex: 1, color: colors.textDim, fontSize: 12 }}>
          {message.text}
        </AppText>
      </View>
    );
  }

  const isUser = message.role === 'user';
  const agent =
    message.role === 'agent' && message.agentId ? getAgent(message.agentId) : null;
  const accent = agent?.accent ?? colors.cyan;
  const label = agent?.name ?? 'NOVA';

  return (
    <View style={{ alignSelf: isUser ? 'flex-end' : 'flex-start', maxWidth: '88%' }}>
      <View
        style={{
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.md + 2,
          borderRadius: radius.lg,
          borderBottomRightRadius: isUser ? 6 : radius.lg,
          borderBottomLeftRadius: isUser ? radius.lg : 6,
          borderWidth: 1,
          borderColor: isUser
            ? 'rgba(139, 92, 246, 0.4)'
            : agent
              ? `${accent}44`
              : colors.hairline,
          backgroundColor: isUser ? 'rgba(139, 92, 246, 0.16)' : 'rgba(12, 17, 36, 0.95)',
        }}
      >
        {!isUser ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginBottom: 4 }}>
            {agent ? <Ionicons name={agent.icon} size={10} color={accent} /> : null}
            <AppText variant="micro" style={{ color: accent }}>
              {label}
            </AppText>
          </View>
        ) : null}
        <AppText variant="body" style={{ color: colors.text }}>
          {message.text}
        </AppText>
        <AppText
          variant="micro"
          align="right"
          style={{ fontSize: 9, marginTop: 4, letterSpacing: 0.5 }}
        >
          {formatClock(message.createdAt)}
        </AppText>
      </View>
    </View>
  );
}
