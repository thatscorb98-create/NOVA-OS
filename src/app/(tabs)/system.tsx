import React from 'react';
import { Alert, Platform, View } from 'react-native';
import Constants from 'expo-constants';
import { Ionicons } from '@expo/vector-icons';

import { Screen } from '@/components/ui/Screen';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { AppText } from '@/components/ui/AppText';
import { StatusDot } from '@/components/ui/Bits';
import { FadeInView } from '@/components/ui/FadeInView';
import { NeonButton } from '@/components/ui/NeonButton';
import { AGENTS } from '@/data/agents';
import { CORE_STATUS_COLOR, NOVA_CORE } from '@/lib/nova-core';
import { useNova } from '@/store/nova-store';
import { colors, spacing } from '@/theme';

const APP_VERSION = Constants.expoConfig?.version ?? '0.1.0';

function InfoRow({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
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
      <AppText variant="bodyStrong" style={{ fontSize: 13, color: color ?? colors.text }}>
        {value}
      </AppText>
    </View>
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
  const { missions, projects, messages, activity, resetWorkspace } = useNova();

  const handleReset = () => {
    Alert.alert(
      'Reset workspace?',
      'Missions, projects, chat history and the activity log stored on this device will be erased.',
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
        <SectionHeader label="Reasoning core" />
        <Panel>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <StatusDot color={CORE_STATUS_COLOR} size={7} />
            <AppText variant="heading">{NOVA_CORE.label}</AppText>
          </View>
          <AppText variant="caption" style={{ marginTop: spacing.sm }}>
            {NOVA_CORE.detail}
          </AppText>

          <View style={{ marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.hairline }}>
            <InfoRow label="Provider" value={NOVA_CORE.provider} />
            <InfoRow label="Model" value={NOVA_CORE.model ?? 'Not configured'} color={colors.textMuted} />
            <InfoRow label="Agents registered" value={String(AGENTS.length)} />
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={60} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Build" />
        <Panel>
          <InfoRow label="Version" value={`${APP_VERSION} · Phase One`} />
          <InfoRow label="Platform" value={`${Platform.OS} ${String(Platform.Version)}`} />
          <InfoRow label="Runtime" value="Expo · React Native" />
          <InfoRow label="Storage" value="On this device only" />
        </Panel>
      </FadeInView>

      <FadeInView delay={120} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Local workspace" />
        <Panel>
          <InfoRow label="Missions" value={String(missions.length)} />
          <InfoRow label="Projects" value={String(projects.length)} />
          <InfoRow label="Chat messages" value={String(messages.length)} />
          <InfoRow label="Activity events" value={String(activity.length)} />
        </Panel>
      </FadeInView>

      <FadeInView delay={180} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Capability status" />
        <Panel style={{ gap: spacing.sm }}>
          <Bullet tone="live" text="Native navigation, dashboard, agent roster and local memory." />
          <Bullet tone="live" text="Missions and projects with real progress derived from your data." />
          <Bullet tone="planned" text="Live model reasoning with streaming replies (Phase Two)." />
          <Bullet tone="planned" text="Agent execution, research tools and approval gates (Phase Three)." />
        </Panel>
      </FadeInView>

      <FadeInView delay={240} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Security" />
        <Panel>
          <AppText variant="caption">
            This build contains no API keys. Keys are never written into the app bundle or the
            repository. When the model core is connected, credentials will be stored in the
            device&apos;s encrypted keystore and used only for provider requests.
          </AppText>
        </Panel>
      </FadeInView>

      <FadeInView delay={300} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Danger zone" />
        <NeonButton label="Reset local workspace" icon="trash-outline" variant="danger" onPress={handleReset} />
      </FadeInView>

      <AppText variant="micro" align="center" style={{ marginTop: spacing.xxl }}>
        NOVA OS · BUILT WITH EXPO + REACT NATIVE
      </AppText>
    </Screen>
  );
}
