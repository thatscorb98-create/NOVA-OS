import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { colors, radius, spacing } from '@/theme';

interface ChipProps {
  label: string;
  color?: string;
  active?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function Chip({ label, color = colors.violet, active, onPress, style }: ChipProps) {
  const content = (
    <View
      style={[
        {
          paddingHorizontal: spacing.md,
          paddingVertical: 7,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: active ? `${color}CC` : `${color}33`,
          backgroundColor: active ? `${color}26` : 'rgba(255,255,255,0.02)',
        },
        style,
      ]}
    >
      <AppText
        variant="micro"
        style={{ color: active ? color : colors.textMuted, letterSpacing: 0.8 }}
      >
        {label.toUpperCase()}
      </AppText>
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable onPress={onPress} hitSlop={6} style={({ pressed }) => ({ opacity: pressed ? 0.7 : 1 })}>
      {content}
    </Pressable>
  );
}

interface StatusDotProps {
  color: string;
  size?: number;
}

export function StatusDot({ color, size = 6 }: StatusDotProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: color,
        shadowColor: color,
        shadowOpacity: 0.9,
        shadowRadius: 6,
        shadowOffset: { width: 0, height: 0 },
      }}
    />
  );
}

interface StatusPillProps {
  label: string;
  color: string;
  pulse?: boolean;
}

export function StatusPill({ label, color }: StatusPillProps) {
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs + 2,
        paddingHorizontal: spacing.sm + 2,
        paddingVertical: 5,
        borderRadius: radius.pill,
        borderWidth: 1,
        borderColor: `${color}44`,
        backgroundColor: `${color}14`,
      }}
    >
      <StatusDot color={color} size={5} />
      <AppText variant="micro" style={{ color, letterSpacing: 0.9 }}>
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}

interface StatTileProps {
  value: string;
  label: string;
  accent?: string;
}

export function StatTile({ value, label, accent = colors.violet }: StatTileProps) {
  return (
    <View
      style={{
        flex: 1,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.hairline,
        backgroundColor: 'rgba(10, 14, 28, 0.9)',
        gap: 2,
      }}
    >
      <AppText variant="title" color={accent} style={{ fontSize: 22, lineHeight: 26 }}>
        {value}
      </AppText>
      <AppText variant="micro" style={{ letterSpacing: 1 }}>
        {label.toUpperCase()}
      </AppText>
    </View>
  );
}
