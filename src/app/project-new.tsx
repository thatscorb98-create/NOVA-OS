import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { AppText } from '@/components/ui/AppText';
import { FormField } from '@/components/ui/FormField';
import { NeonButton } from '@/components/ui/NeonButton';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';

const ACCENTS = [
  { label: 'Violet', value: colors.violet },
  { label: 'Cyan', value: colors.cyan },
  { label: 'Emerald', value: colors.emerald },
  { label: 'Pink', value: colors.pink },
];

export default function NewProjectScreen() {
  const router = useRouter();
  const { createProject } = useNova();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [accent, setAccent] = useState(ACCENTS[0].value);

  const canSave = name.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;

    createProject({ name, description, accent });
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    router.back();
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={['top', 'left', 'right', 'bottom']} style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: spacing.xl,
            paddingVertical: spacing.md,
            borderBottomWidth: 1,
            borderBottomColor: colors.hairline,
          }}
        >
          <Pressable onPress={() => router.back()} hitSlop={12}>
            <AppText variant="bodyStrong" color={colors.textMuted}>
              Cancel
            </AppText>
          </Pressable>
          <AppText variant="heading">New Project</AppText>
          <View style={{ width: 46 }} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={{ padding: spacing.xl, paddingBottom: spacing.xxl, gap: spacing.xl }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <FormField
              label="Project name"
              placeholder="e.g. NOVA Launch"
              value={name}
              onChangeText={setName}
              autoFocus
              maxLength={80}
            />

            <FormField
              label="Description"
              placeholder="What is this project meant to achieve?"
              value={description}
              onChangeText={setDescription}
              multiline
              maxLength={600}
            />

            <View style={{ gap: spacing.md }}>
              <AppText variant="label">ACCENT</AppText>
              <View style={{ flexDirection: 'row', gap: spacing.md }}>
                {ACCENTS.map((item) => {
                  const selected = item.value === accent;

                  return (
                    <Pressable
                      key={item.label}
                      onPress={() => setAccent(item.value)}
                      accessibilityRole="button"
                      accessibilityLabel={`${item.label} accent`}
                      style={{
                        width: 40,
                        height: 40,
                        borderRadius: radius.pill,
                        borderWidth: selected ? 2 : 1,
                        borderColor: selected ? item.value : colors.hairline,
                        backgroundColor: `${item.value}22`,
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {selected ? (
                        <Ionicons name="checkmark" size={16} color={item.value} />
                      ) : (
                        <View
                          style={{
                            width: 10,
                            height: 10,
                            borderRadius: 5,
                            backgroundColor: item.value,
                          }}
                        />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            </View>
          </ScrollView>

          <View
            style={{
              paddingHorizontal: spacing.xl,
              paddingTop: spacing.sm,
              paddingBottom: spacing.md,
              borderTopWidth: 1,
              borderTopColor: colors.hairline,
            }}
          >
            <NeonButton
              label="Create project"
              icon="layers"
              onPress={handleSave}
              disabled={!canSave}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
