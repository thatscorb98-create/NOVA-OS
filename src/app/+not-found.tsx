import React from 'react';
import { View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Link } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { colors, spacing } from '@/theme';

export default function NotFoundScreen() {
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={['top', 'bottom']} style={{ flex: 1 }}>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingHorizontal: spacing.xxl,
            gap: spacing.sm,
          }}
        >
          <AppText variant="micro" style={{ letterSpacing: 2 }}>
            SIGNAL LOST
          </AppText>
          <AppText variant="title" align="center">
            This route is outside the grid.
          </AppText>
          <AppText variant="caption" align="center">
            The screen you tried to open does not exist in NOVA OS.
          </AppText>

          <Link href="/" style={{ marginTop: spacing.lg }}>
            <AppText variant="bodyStrong" color={colors.violetBright}>
              Return to Command Center
            </AppText>
          </Link>
        </View>
      </SafeAreaView>
    </View>
  );
}
