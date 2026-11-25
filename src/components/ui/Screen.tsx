import React from 'react';
import {
  ScrollView,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';

import { AppText } from '@/components/ui/AppText';
import { StatusDot } from '@/components/ui/Bits';
import { colors, spacing } from '@/theme';

interface ScreenProps {
  eyebrow?: string;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  scroll?: boolean;
  contentContainerStyle?: StyleProp<ViewStyle>;
}

/** Shared page frame: atmospheric backdrop, header block and safe areas. */
export function Screen({
  eyebrow,
  title,
  subtitle,
  right,
  children,
  scroll = true,
  contentContainerStyle,
}: ScreenProps) {
  const body = scroll ? (
    <ScrollView
      showsVerticalScrollIndicator={false}
      contentContainerStyle={[
        { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxxl },
        contentContainerStyle,
      ]}
      keyboardShouldPersistTaps="handled"
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[{ flex: 1 }, contentContainerStyle]}>{children}</View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(139, 92, 246, 0.13)', 'rgba(34, 211, 238, 0.04)', 'transparent']}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 340 }}
      />
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <View
          style={{
            paddingHorizontal: spacing.xl,
            paddingTop: spacing.sm,
            paddingBottom: spacing.lg,
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              minHeight: 22,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              {eyebrow ? (
                <>
                  <StatusDot color={colors.violet} size={5} />
                  <AppText variant="micro" style={{ letterSpacing: 2 }}>
                    {eyebrow.toUpperCase()}
                  </AppText>
                </>
              ) : null}
            </View>
            {right}
          </View>

          <AppText variant="display" style={{ marginTop: spacing.sm }}>
            {title}
          </AppText>

          {subtitle ? (
            <AppText variant="subtitle" style={{ marginTop: spacing.xs }}>
              {subtitle}
            </AppText>
          ) : null}
        </View>

        {body}
      </SafeAreaView>
    </View>
  );
}
