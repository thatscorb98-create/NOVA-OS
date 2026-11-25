import React from 'react';
import { Alert, Platform, Pressable, View } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Screen } from '@/components/ui/Screen';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { AppText } from '@/components/ui/AppText';
import { StatusDot } from '@/components/ui/Bits';
import { FadeInView } from '@/components/ui/FadeInView';
import { NeonButton } from '@/components/ui/NeonButton';
import { AGENTS } from '@/data/agents';
import { countMemoriesByScope } from '@/lib/memory';
import { NIM_MODELS } from '@/lib/model/models';
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, spacing } from '@/theme';

const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

function InfoRow({
  label,
  value,
  color,
  onPress,
}: {
  label: string;
  value: string;
  color?: string;
  onPress?: () => void;
}) {
  const content = (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: spacing.md,
        paddingVertical: spacing.sm + 2,
      }}
    >
      <AppText variant="micro" style={{ letterSpacing: 1 }}>
        {label.toUpperCase()}
      </AppText>
      <AppText
        variant="bodyStrong"
        numberOfLines={1}
        style={{ fontSize: 13, color: color ?? colors.text, maxWidth: '62%' }}
      >
        {value}
      </AppText>
    </View>
  );

  if (!onPress) return content;

  return (
    <Pressable onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}>
      {content}
    </Pressable>
  );
}

function Bullet({ tone, text }: { tone: 'live' | 'planned'; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
      <Ionicons
        name={tone === 'live' ? 'checkmark-circle' : 'ellipse-outline'}
        size={14}
        color={tone === 'live' ? colors.success : colors.textDim}
        style={{ marginTop: 2 }}
      />
      <AppText variant="caption" style={{ flex: 1 }}>
        {text}
      </AppText>
    </View>
  );
}

export default function SystemScreen() {
  const router = useRouter();
  const { missions, projects, messages, activity, threads, agents, memories, resetWorkspace } =
    useNova();
  const runtime = useAgentRuntime();
  const memoryCounts = countMemoriesByScope(memories);

  const modelLabel =
    NIM_MODELS.find((model) => model.id === runtime.model)?.label ?? runtime.model;
  const disabledAgents = AGENTS.filter((agent) => agents[agent.id]?.enabled === false).length;
  const threadCount = Object.values(threads).reduce((total, list) => total + list.length, 0);

  const handleReset = () => {
    Alert.alert(
      'Reset workspace?',
      'Missions, projects, conversations, agent memory and the activity log stored on this device will be erased. Your API key stays in the keystore.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: () => {
            void resetWorkspace();
          },
        },
      ],
    );
  };

  return (
    <Screen
      eyebrow="Nova OS"
      title="System"
      subtitle="Core status, build information and local data."
    >
      <FadeInView>
        <SectionHeader
          label="Reasoning core"
          actionLabel="Configure"
          onAction={() => router.push('/core')}
        />
        <Panel accent={runtime.hasKey ? colors.success : colors.amber}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={runtime.hasKey ? colors.success : colors.amber} size={7} />
            <AppText variant="heading">
              {runtime.hasKey ? 'CORE ONLINE' : 'CORE OFFLINE'}
            </AppText>
          </View>
          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {runtime.hasKey
              ? 'Agents make real NVIDIA NIM requests. Every result is stored on this device.'
              : 'No model key is stored. Agents will not answer and missions will not run until you connect the core.'}
          </AppText>

          <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.hairline }}>
            <InfoRow label="Provider" value="NVIDIA NIM" />
            <InfoRow label="Model" value={modelLabel} color={colors.textMuted} />
            <InfoRow
              label="API key"
              value={runtime.hasKey ? 'Stored in keystore' : 'Not set'}
              color={runtime.hasKey ? colors.success : colors.amber}
            />
            <InfoRow label="Agents registered" value={`${AGENTS.length} · ${disabledAgents} disabled`} />
          </View>

          <View style={{ marginTop: spacing.md }}>
            <NeonButton
              label={runtime.hasKey ? 'Core settings' : 'Connect the core'}
              icon="key-outline"
              variant={runtime.hasKey ? 'ghost' : 'solid'}
              onPress={() => router.push('/core')}
            />
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Build" />
        <Panel>
          <InfoRow label="Version" value={`${APP_VERSION} · Phase Two`} />
          <InfoRow label="Platform" value={`${Platform.OS} ${String(Platform.Version)}`} />
          <InfoRow label="Runtime" value="Expo · React Native" />
          <InfoRow label="Storage" value="On this device only" />
        </Panel>
      </FadeInView>

      <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
        <SectionHeader
          label="Local workspace"
          actionLabel="Agents"
          onAction={() => router.push('/agents')}
        />
        <Panel>
          <InfoRow label="Missions" value={String(missions.length)} />
          <InfoRow
            label="Delivered results"
            value={String(missions.filter((mission) => mission.result).length)}
            color={colors.success}
          />
          <InfoRow label="Projects" value={String(projects.length)} />
          <InfoRow label="NOVA messages" value={String(messages.length)} />
          <InfoRow label="Agent messages" value={String(threadCount)} />
          <InfoRow label="Activity events" value={String(activity.length)} />
        </Panel>
      </FadeInView>

      <FadeInView delay={150} style={{ marginTop: spacing.xxl }}>
        <SectionHeader
          label="Persistent memory"
          actionLabel="Open"
          onAction={() => router.push('/memory')}
        />
        <Panel>
          <InfoRow label="Memories" value={String(memories.length)} />
          <InfoRow
            label="Pinned"
            value={String(memories.filter((memory) => memory.pinned).length)}
            color={colors.amber}
          />
          <InfoRow label="Project" value={String(memoryCounts.project)} color={colors.cyan} />
          <InfoRow label="Agent" value={String(memoryCounts.agent)} color={colors.emerald} />
          <InfoRow label="Conversations" value={String(memoryCounts.conversation)} />
          <View style={{ marginTop: spacing.md }}>
            <NeonButton
              label="Review saved memories"
              icon="library-outline"
              variant="ghost"
              onPress={() => router.push('/memory')}
            />
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={180} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Capability status" />
        <Panel style={{ gap: spacing.sm }}>
          <Bullet tone="live" text="Real model calls through NVIDIA NIM with the key you control." />
          <Bullet tone="live" text="NOVA delegates to ATLAS, FORGE, ECHO, STERLING, RELAY and SENTINEL using tool calls." />
          <Bullet tone="live" text="Per-agent conversations, memory and completed work persisted on device." />
          <Bullet tone="live" text="Persistent memory across conversations, projects and agents, recalled on every turn and fully editable." />
          <Bullet tone="live" text="Agents can be enabled, disabled and assigned work individually." />
          <Bullet tone="planned" text="Live web research, file access and streaming replies are not part of this build." />
        </Panel>
      </FadeInView>

      <FadeInView delay={240} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Security" />
        <Panel>
          <AppText variant="caption">
            Your NVIDIA API key is stored in the phone&apos;s encrypted keystore and sent only to
            integrate.api.nvidia.com as an Authorization header. It is never written into this
            repository, the app bundle or the workspace database. Model output stays on this phone;
            treat it as advice, not verified fact. Memories are stored only on this device and are
            never uploaded to a server.
          </AppText>
        </Panel>
      </FadeInView>

      <FadeInView delay={300} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Danger zone" />
        <NeonButton
          label="Reset local workspace"
          icon="trash-outline"
          variant="danger"
          onPress={handleReset}
        />
      </FadeInView>

      <AppText variant="micro" align="center" style={{ marginTop: spacing.xxl }}>
        NOVA OS · BUILT WITH EXPO + REACT NATIVE
      </AppText>
    </Screen>
  );
}
