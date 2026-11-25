import React from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import type { BottomTabBarProps } from 'expo-router/js-tabs';

import { AppText } from '@/components/ui/AppText';
import { colors, radius, spacing } from '@/theme';
import type { IconName } from '@/types/nova';

interface TabMeta {
  label: string;
  icon: IconName;
  activeIcon: IconName;
}

const TAB_META: Record<string, TabMeta> = {
  index: { label: 'Home', icon: 'grid-outline', activeIcon: 'grid' },
  chat: { label: 'Chat', icon: 'sparkles-outline', activeIcon: 'sparkles' },
  agents: { label: 'Agents', icon: 'people-outline', activeIcon: 'people' },
  missions: { label: 'Missions', icon: 'compass-outline', activeIcon: 'compass' },
  projects: { label: 'Projects', icon: 'layers-outline', activeIcon: 'layers' },
  system: { label: 'System', icon: 'settings-outline', activeIcon: 'settings' },
};

/** Custom bottom navigation: six modules on one continuous command surface. */
export function NovaTabBar({ state, navigateToTab }: BottomTabBarProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        paddingTop: spacing.sm,
        paddingHorizontal: spacing.xs,
        paddingBottom: Math.max(insets.bottom, spacing.sm),
        backgroundColor: 'rgba(4, 5, 10, 0.98)',
        borderTopWidth: 1,
        borderTopColor: colors.hairline,
      }}
    >
      {state.routes.map((route, index) => {
        const meta =
          TAB_META[route.name] ?? {
            label: route.name,
            icon: 'ellipse-outline' as IconName,
            activeIcon: 'ellipse' as IconName,
          };
        const isFocused = state.index === index;

        return (
          <Pressable
            key={route.key}
            onPress={() => {
              Haptics.selectionAsync().catch(() => {});
              navigateToTab(route.key);
            }}
            accessibilityRole="tab"
            accessibilityState={isFocused ? { selected: true } : {}}
            accessibilityLabel={meta.label}
            style={{ flex: 1, alignItems: 'center', gap: 3, paddingVertical: spacing.xs }}
          >
            <View
              style={{
                width: 36,
                height: 24,
                borderRadius: radius.pill,
                alignItems: 'center',
                justifyContent: 'center',
                backgroundColor: isFocused ? 'rgba(139, 92, 246, 0.18)' : 'transparent',
                shadowColor: colors.violet,
                shadowOpacity: isFocused ? 0.6 : 0,
                shadowRadius: 10,
                shadowOffset: { width: 0, height: 0 },
              }}
            >
              <Ionicons
                name={isFocused ? meta.activeIcon : meta.icon}
                size={17}
                color={isFocused ? colors.violetBright : colors.textDim}
              />
            </View>
            <AppText
              variant="micro"
              style={{
                fontSize: 9,
                letterSpacing: 0.4,
                color: isFocused ? colors.text : colors.textDim,
              }}
            >
              {meta.label}
            </AppText>
          </Pressable>
        );
      })}
    </View>
  );
}
