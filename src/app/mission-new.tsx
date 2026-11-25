import React, { useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { AppText } from '@/components/ui/AppText';
import { Chip } from '@/components/ui/Bits';
import { FormField } from '@/components/ui/FormField';
import { NeonButton } from '@/components/ui/NeonButton';
import { AGENTS, DEFAULT_AGENT_ID } from '@/data/agents';
import { useNova } from '@/store/nova-store';
import { colors, spacing } from '@/theme';
import type { AgentId } from '@/types/nova';

export default function NewMissionScreen() {
  const router = useRouter();
  const { createMission, projects } = useNova();
  const params = useLocalSearchParams<{ agentId?: string; projectId?: string }>();

  const initialAgent = AGENTS.find((agent) => agent.id === params.agentId)?.id ?? DEFAULT_AGENT_ID;

  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [agentId, setAgentId] = useState<AgentId>(initialAgent);
  const [projectId, setProjectId] = useState<string | undefined>(
    projects.some((project) => project.id === params.projectId) ? params.projectId : undefined,
  );

  const canSave = title.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;

    createMission({ title, objective, agentId, projectId });
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
          <AppText variant="heading">New Mission</AppText>
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
              label="Mission title"
              placeholder="e.g. Research the top 5 competitors"
              value={title}
              onChangeText={setTitle}
              autoFocus
              maxLength={120}
              returnKeyType="next"
            />

            <FormField
              label="Objective"
              placeholder="What does success look like? Context, constraints, deliverables…"
              value={objective}
              onChangeText={setObjective}
              multiline
              maxLength={2000}
            />

            <View style={{ gap: spacing.md }}>
              <AppText variant="label">ASSIGN TO</AppText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {AGENTS.map((agent) => (
                  <Chip
                    key={agent.id}
                    label={agent.name}
                    color={agent.accent}
                    active={agentId === agent.id}
                    onPress={() => setAgentId(agent.id)}
                  />
                ))}
              </View>
              <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
                {AGENTS.find((agent) => agent.id === agentId)?.role.toUpperCase()}
              </AppText>
            </View>

            {projects.length > 0 ? (
              <View style={{ gap: spacing.md }}>
                <AppText variant="label">LINK TO PROJECT (OPTIONAL)</AppText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  <Chip
                    label="None"
                    active={!projectId}
                    onPress={() => setProjectId(undefined)}
                  />
                  {projects.map((project) => (
                    <Chip
                      key={project.id}
                      label={project.name}
                      color={project.accent}
                      active={projectId === project.id}
                      onPress={() => setProjectId(project.id)}
                    />
                  ))}
                </View>
              </View>
            ) : null}
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
              label="Create mission"
              icon="compass"
              onPress={handleSave}
              disabled={!canSave}
            />
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
