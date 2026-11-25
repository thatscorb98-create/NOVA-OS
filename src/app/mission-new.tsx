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
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, spacing } from '@/theme';
import type { AgentId, MissionKind, MissionRunMode } from '@/types/nova';

export default function NewMissionScreen() {
  const router = useRouter();
  const { createMission, projects } = useNova();
  const runtime = useAgentRuntime();
  const params = useLocalSearchParams<{ agentId?: string; projectId?: string }>();

  const initialAgent = AGENTS.find((agent) => agent.id === params.agentId)?.id ?? DEFAULT_AGENT_ID;

  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [kind, setKind] = useState<MissionKind>('planned');
  const [mode, setMode] = useState<MissionRunMode>('review');
  const [agentId, setAgentId] = useState<AgentId>(initialAgent);
  const [projectId, setProjectId] = useState<string | undefined>(
    projects.some((project) => project.id === params.projectId) ? params.projectId : undefined,
  );

  const canSave = title.trim().length > 0;

  const handleSave = () => {
    if (!canSave) return;

    const mission = createMission({
      title,
      objective,
      agentId: kind === 'planned' ? 'nova' : agentId,
      projectId,
      kind,
      mode,
    });

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    router.back();

    if (kind === 'planned') {
      // Let the store commit before the runtime reads the mission back.
      setTimeout(() => {
        void runtime.runMission(mission.id);
      }, 250);
    }
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
          <AppText variant="heading">{kind === 'planned' ? 'New Goal' : 'New Mission'}</AppText>
          <View style={{ width: 46 }} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={{
              padding: spacing.xl,
              paddingBottom: spacing.xxl,
              gap: spacing.xl,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <FormField
              label={kind === 'planned' ? 'Goal' : 'Mission title'}
              placeholder="e.g. Launch the pricing page"
              value={title}
              onChangeText={setTitle}
              autoFocus
              maxLength={120}
              returnKeyType="next"
            />

            <FormField
              label="Brief"
              placeholder="What does success look like? Context, constraints, audience, deliverables…"
              value={objective}
              onChangeText={setObjective}
              multiline
              maxLength={2000}
            />

            <View style={{ gap: spacing.md }}>
              <AppText variant="label">EXECUTION</AppText>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                <Chip
                  label="Plan & delegate"
                  active={kind === 'planned'}
                  onPress={() => setKind('planned')}
                />
                <Chip
                  label="One specialist"
                  active={kind === 'single'}
                  color={colors.cyan}
                  onPress={() => setKind('single')}
                />
              </View>
              <AppText variant="micro" style={{ lineHeight: 16 }}>
                {kind === 'planned'
                  ? 'NOVA BREAKS THE GOAL INTO UP TO 5 TASKS, ASSIGNS EACH TO A SPECIALIST, REVIEWS THE OUTPUT AND WRITES A FINAL REPORT.'
                  : 'THE WHOLE OBJECTIVE GOES TO ONE AGENT IN A SINGLE RUN.'}
              </AppText>
            </View>

            {kind === 'planned' ? (
              <View style={{ gap: spacing.md }}>
                <AppText variant="label">PLAN APPROVAL</AppText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  <Chip
                    label="Review plan first"
                    active={mode === 'review'}
                    onPress={() => setMode('review')}
                  />
                  <Chip
                    label="Auto-run"
                    active={mode === 'auto'}
                    color={colors.emerald}
                    onPress={() => setMode('auto')}
                  />
                </View>
                <AppText variant="micro" style={{ lineHeight: 16 }}>
                  {mode === 'review'
                    ? 'NOVA PLANS, THEN WAITS FOR YOU TO APPROVE BEFORE ANY SPECIALIST RUNS.'
                    : 'NOVA PLANS AND RUNS IMMEDIATELY. LIMITS STILL APPLY.'}
                </AppText>
              </View>
            ) : (
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
            )}

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
              gap: spacing.xs,
            }}
          >
            <NeonButton
              label={kind === 'planned' ? 'Plan with NOVA' : 'Create mission'}
              icon={kind === 'planned' ? 'sparkles' : 'compass'}
              onPress={handleSave}
              disabled={!canSave}
            />
            {kind === 'planned' && !runtime.hasKey ? (
              <AppText variant="micro" align="center" style={{ color: colors.amber }}>
                CORE OFFLINE · THE MISSION IS SAVED BUT WILL NOT PLAN UNTIL YOU ADD A KEY
              </AppText>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
