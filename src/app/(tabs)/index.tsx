import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';

import { Screen } from '@/components/ui/Screen';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { AppText } from '@/components/ui/AppText';
import { StatTile, StatusDot, StatusPill } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { NeonButton } from '@/components/ui/NeonButton';
import { AgentCard } from '@/components/nova/AgentCard';
import { NovaOrb } from '@/components/nova/NovaOrb';
import { MISSION_STATUS_META } from '@/components/nova/MissionCard';
import { AGENTS, getAgent } from '@/data/agents';
import { formatRelative } from '@/lib/time';
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, spacing } from '@/theme';
import type { ActivityEvent, IconName } from '@/types/nova';

const ACTIVITY_ICONS: Record<ActivityEvent['kind'], IconName> = {
  mission: 'compass-outline',
  project: 'layers-outline',
  chat: 'chatbubble-ellipses-outline',
  system: 'pulse-outline',
  agent: 'people-outline',
};

export default function HomeScreen() {
  const router = useRouter();
  const { missions, projects, activity, memories } = useNova();
  const runtime = useAgentRuntime();

  const openMissions = missions.filter((mission) => mission.status !== 'complete');
  const delivered = missions.filter((mission) => mission.result).length;
  const activeCountFor = (agentId: string) =>
    openMissions.filter((mission) => mission.agentId === agentId).length;

  const summary =
    openMissions.length === 0
      ? 'No missions in flight. Create one and NOVA routes it to a specialist.'
      : `${openMissions.length} mission${openMissions.length === 1 ? '' : 's'} in flight across your network.`;

  return (
    <Screen
      eyebrow="Nova OS"
      title="Command Center"
      subtitle="Your autonomous operations hub."
      right={
        <StatusPill
          label={runtime.hasKey ? 'Core online' : 'Core offline'}
          color={runtime.hasKey ? colors.success : colors.amber}
        />
      }
    >
      <FadeInView>
        <Panel glow style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
          <NovaOrb size={148} offline={!runtime.hasKey} />

          <AppText variant="title" style={{ marginTop: spacing.md, letterSpacing: 7 }}>
            NOVA
          </AppText>
          <AppText variant="micro" style={{ marginTop: spacing.xs, letterSpacing: 1.6 }}>
            CENTRAL INTELLIGENCE
          </AppText>
          <AppText
            variant="caption"
            align="center"
            style={{ marginTop: spacing.md, maxWidth: 280 }}
          >
            {summary}
          </AppText>

          <Pressable onPress={() => router.push('/core')} hitSlop={6}>
            {({ pressed }) => (
              <AppText
                variant="micro"
                align="center"
                style={{
                  marginTop: spacing.md,
                  letterSpacing: 0.7,
                  color: runtime.hasKey ? colors.success : pressed ? colors.cyanBright : colors.amber,
                }}
              >
                {runtime.hasKey
                  ? `CORE LINKED · ${runtime.model.split('/')[1]?.toUpperCase() ?? runtime.model}`
                  : 'CORE OFFLINE · TAP TO CONNECT YOUR MODEL KEY'}
              </AppText>
            )}
          </Pressable>

          <Pressable
            onPress={() => router.push('/memory')}
            hitSlop={6}
            style={{
              marginTop: spacing.md,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 5,
            }}
          >
            <Ionicons name="library-outline" size={11} color={colors.violetBright} />
            <AppText variant="micro" style={{ color: colors.violetBright }}>
              MEMORY · {memories.length} SAVED
            </AppText>
          </Pressable>

          <View
            style={{
              flexDirection: 'row',
              gap: spacing.sm,
              marginTop: spacing.lg,
              alignSelf: 'stretch',
            }}
          >
            <View style={{ flex: 1 }}>
              <NeonButton label="Open Chat" icon="sparkles" onPress={() => router.push('/chat')} />
            </View>
            <View style={{ flex: 1 }}>
              <NeonButton
                label="New Mission"
                icon="add"
                variant="ghost"
                onPress={() => router.push('/mission-new')}
              />
            </View>
          </View>
        </Panel>
      </FadeInView>

      <FadeInView delay={80}>
        <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }}>
          <StatTile value={String(openMissions.length)} label="Open missions" />
          <StatTile value={String(delivered)} label="Delivered" accent={colors.emerald} />
          <StatTile value={String(AGENTS.length)} label="Agents" accent={colors.cyan} />
        </View>
      </FadeInView>

      <FadeInView delay={140} style={{ marginTop: spacing.xxl }}>
        <SectionHeader
          label="Mission control"
          actionLabel="View all"
          onAction={() => router.push('/missions')}
        />
        <Panel padded={false}>
          {openMissions.length === 0 ? (
            <View style={{ padding: spacing.lg }}>
              <EmptyState
                compact
                icon="compass-outline"
                title="No active missions"
                body="Missions you create are tracked here until they are complete."
                actionLabel="Create mission"
                onAction={() => router.push('/mission-new')}
              />
            </View>
          ) : (
            openMissions.slice(0, 3).map((mission, index) => {
              const agent = getAgent(mission.agentId);
              const meta = MISSION_STATUS_META[mission.status];

              return (
                <Pressable
                  key={mission.id}
                  onPress={() => router.push(`/mission/${mission.id}`)}
                  style={({ pressed }) => ({
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.md,
                    paddingHorizontal: spacing.lg,
                    paddingVertical: spacing.md,
                    borderTopWidth: index === 0 ? 0 : 1,
                    borderTopColor: colors.hairline,
                    opacity: pressed ? 0.7 : 1,
                  })}
                >
                  <StatusDot color={meta.color} />
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodyStrong" numberOfLines={1}>
                      {mission.title}
                    </AppText>
                    <AppText variant="micro" style={{ marginTop: 2 }}>
                      {agent.name} · {meta.label.toUpperCase()}
                    </AppText>
                  </View>
                  <Ionicons name="chevron-forward" size={14} color={colors.textDim} />
                </Pressable>
              );
            })
          )}
        </Panel>
      </FadeInView>

      <FadeInView delay={200} style={{ marginTop: spacing.xxl }}>
        <SectionHeader
          label="Agent network"
          actionLabel="View all"
          onAction={() => router.push('/agents')}
        />
        <View style={{ gap: spacing.sm }}>
          {AGENTS.slice(0, 3).map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              compact
              activeMissions={activeCountFor(agent.id)}
              onPress={() => router.push(`/agent/${agent.id}`)}
            />
          ))}
        </View>
      </FadeInView>

      <FadeInView delay={260} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Recent activity" />
        <Panel padded={false}>
          {activity.length === 0 ? (
            <AppText variant="caption" style={{ padding: spacing.lg }}>
              Your workspace log is empty. Missions and projects you create appear here.
            </AppText>
          ) : (
            activity.slice(0, 5).map((event, index) => (
              <View
                key={event.id}
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.md,
                  paddingHorizontal: spacing.lg,
                  paddingVertical: spacing.md,
                  borderTopWidth: index === 0 ? 0 : 1,
                  borderTopColor: colors.hairline,
                }}
              >
                <Ionicons
                  name={ACTIVITY_ICONS[event.kind]}
                  size={14}
                  color={colors.violetBright}
                />
                <View style={{ flex: 1 }}>
                  <AppText variant="bodyStrong" style={{ fontSize: 13 }}>
                    {event.label}
                  </AppText>
                  {event.detail ? (
                    <AppText variant="micro" numberOfLines={1} style={{ marginTop: 2 }}>
                      {event.detail}
                    </AppText>
                  ) : null}
                </View>
                <AppText variant="micro">{formatRelative(event.createdAt).toUpperCase()}</AppText>
              </View>
            ))
          )}
        </Panel>
      </FadeInView>
    </Screen>
  );
}
