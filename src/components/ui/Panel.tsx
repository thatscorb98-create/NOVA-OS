import React from 'react';
import { Pressable, View, type StyleProp, type ViewStyle } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { AppText } from '@/components/ui/AppText';
import { colors, radius, spacing } from '@/theme';

interface PanelProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  padded?: boolean;
  accent?: string;
  glow?: boolean;
}

/** Deep-navy glass panel used for every surface in the app. */
export function Panel({ children, style, onPress, padded = true, accent, glow }: PanelProps) {
  const surface = (
    <LinearGradient
      colors={['#0C1124', '#070A15']}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={[
        {
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: accent ? `${accent}44` : colors.panelBorder,
          backgroundColor: colors.panel,
          overflow: 'hidden',
        },
        padded && { padding: spacing.lg },
        glow && {
          shadowColor: accent ?? colors.violet,
          shadowOpacity: 0.25,
          shadowRadius: 20,
          shadowOffset: { width: 0, height: 8 },
        },
        style,
      ]}
    >
      {children}
    </LinearGradient>
  );

  if (!onPress) return surface;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.86 : 1 })}>
      {surface}
    </Pressable>
  );
}

interface SectionHeaderProps {
  label: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
}

export function SectionHeader({ label, actionLabel, onAction, style }: SectionHeaderProps) {
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: spacing.md,
        },
        style,
      ]}
    >
      <AppText variant="label" style={{ color: colors.textMuted }}>
        {label.toUpperCase()}
      </AppText>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} hitSlop={12}>
          {({ pressed }) => (
            <AppText variant="micro" style={{ color: pressed ? colors.cyanBright : colors.cyan }}>
              {actionLabel.toUpperCase()}
            </AppText>
          )}
        </Pressable>
      ) : null}
    </View>
  );
}
