import React from 'react';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { colors, radius, spacing } from '@/theme';
import type { IconName } from '@/types/nova';

interface NeonButtonProps {
  label: string;
  onPress: () => void;
  icon?: IconName;
  variant?: 'solid' | 'ghost' | 'danger';
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
}

/** Primary action control with the NOVA violet glow. */
export function NeonButton({
  label,
  onPress,
  icon,
  variant = 'solid',
  disabled,
  loading,
  fullWidth = true,
}: NeonButtonProps) {
  const isSolid = variant === 'solid';
  const isDanger = variant === 'danger';
  const textColor = isSolid ? colors.white : isDanger ? colors.danger : colors.violetBright;

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        opacity: disabled ? 0.4 : pressed ? 0.85 : 1,
        alignSelf: fullWidth ? 'stretch' : 'flex-start',
      })}
    >
      {isSolid ? (
        <LinearGradient
          colors={[colors.violet, colors.violetDeep]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.sm,
            paddingVertical: 14,
            paddingHorizontal: spacing.xl,
            borderRadius: radius.md,
            shadowColor: colors.violet,
            shadowOpacity: 0.5,
            shadowRadius: 16,
            shadowOffset: { width: 0, height: 6 },
          }}
        >
          <ButtonContent label={label} icon={icon} color={textColor} loading={loading} />
        </LinearGradient>
      ) : (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spacing.sm,
            paddingVertical: 13,
            paddingHorizontal: spacing.xl,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: isDanger ? `${colors.danger}55` : `${colors.violet}55`,
            backgroundColor: 'rgba(139, 92, 246, 0.08)',
          }}
        >
          <ButtonContent label={label} icon={icon} color={textColor} loading={loading} />
        </View>
      )}
    </Pressable>
  );
}

function ButtonContent({
  label,
  icon,
  color,
  loading,
}: {
  label: string;
  icon?: IconName;
  color: string;
  loading?: boolean;
}) {
  if (loading) {
    return <ActivityIndicator size="small" color={color} />;
  }

  return (
    <>
      {icon ? <Ionicons name={icon} size={16} color={color} /> : null}
      <AppText variant="bodyStrong" color={color} style={{ letterSpacing: 0.2 }}>
        {label}
      </AppText>
    </>
  );
}
