import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { colors, radius, spacing } from '@/theme';

interface DetailHeaderProps {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
}

export function DetailHeader({ title, subtitle, right }: DetailHeaderProps) {
  const router = useRouter();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
      }}
    >
      <Pressable
        onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))}
        hitSlop={12}
        accessibilityRole="button"
        accessibilityLabel="Go back"
        style={({ pressed }) => ({
          width: 38,
          height: 38,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: colors.hairline,
          backgroundColor: 'rgba(255,255,255,0.03)',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: pressed ? 0.6 : 1,
        })}
      >
        <Ionicons name="chevron-back" size={18} color={colors.text} />
      </Pressable>

      <View style={{ flex: 1 }}>
        {title ? <AppText variant="heading">{title}</AppText> : null}
        {subtitle ? (
          <AppText variant="micro" style={{ marginTop: 2 }}>
            {subtitle.toUpperCase()}
          </AppText>
        ) : null}
      </View>

      {right}
    </View>
  );
}
