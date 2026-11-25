import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { colors, radius, spacing } from '@/theme';
import type { IconName } from '@/types/nova';

interface EmptyStateProps {
  icon: IconName;
  title: string;
  body: string;
  actionLabel?: string;
  onAction?: () => void;
  compact?: boolean;
}

export function EmptyState({
  icon,
  title,
  body,
  actionLabel,
  onAction,
  compact,
}: EmptyStateProps) {
  return (
    <View
      style={{
        alignItems: compact ? 'flex-start' : 'center',
        paddingVertical: compact ? spacing.md : spacing.xxl,
        paddingHorizontal: compact ? 0 : spacing.lg,
        gap: spacing.sm,
      }}
    >
      {!compact ? (
        <View
          style={{
            width: 48,
            height: 48,
            borderRadius: radius.pill,
            borderWidth: 1,
            borderColor: colors.hairline,
            backgroundColor: 'rgba(139, 92, 246, 0.08)',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: spacing.xs,
          }}
        >
          <Ionicons name={icon} size={20} color={colors.violetBright} />
        </View>
      ) : null}

      <AppText variant="heading" align={compact ? 'left' : 'center'}>
        {title}
      </AppText>
      <AppText
        variant="caption"
        align={compact ? 'left' : 'center'}
        style={{ maxWidth: 300 }}
      >
        {body}
      </AppText>

      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={10} style={{ marginTop: spacing.sm }}>
          {({ pressed }) => (
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: spacing.xs,
                paddingHorizontal: spacing.lg,
                paddingVertical: spacing.sm,
                borderRadius: radius.pill,
                borderWidth: 1,
                borderColor: `${colors.violet}55`,
                backgroundColor: 'rgba(139, 92, 246, 0.1)',
                opacity: pressed ? 0.7 : 1,
              }}
            >
              <Ionicons name="add" size={14} color={colors.violetBright} />
              <AppText variant="micro" style={{ color: colors.violetBright }}>
                {actionLabel.toUpperCase()}
              </AppText>
            </View>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
