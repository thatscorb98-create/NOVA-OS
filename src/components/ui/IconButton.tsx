import React from 'react';
import { Pressable } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { colors, radius } from '@/theme';
import type { IconName } from '@/types/nova';

interface IconButtonProps {
  icon: IconName;
  onPress: () => void;
  label: string;
  accent?: string;
}

/** Compact circular action used in screen headers. */
export function IconButton({ icon, onPress, label, accent = colors.violet }: IconButtonProps) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={10}
      style={({ pressed }) => ({
        width: 36,
        height: 36,
        borderRadius: radius.pill,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1,
        borderColor: `${accent}55`,
        backgroundColor: `${accent}18`,
        opacity: pressed ? 0.65 : 1,
      })}
    >
      <Ionicons name={icon} size={17} color={accent} />
    </Pressable>
  );
}
