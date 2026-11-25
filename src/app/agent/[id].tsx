import React from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusPill } from '@/components/ui/Bits';
import { DetailHeader } from '@/components/ui/DetailHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { NeonButton } from '@/components/ui/NeonButton';
import { MissionCard } from '@/components/nova/MissionCard';
import { getAgent } from '@/data/agents';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';
import type { AgentId } from '@/types/nova';

export default function AgentScreen() {
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const agent = getAgent((id as AgentId) ?? 'nova');
  const { missions, projects, advanceMission, deleteMission } = useNova();

  const agentMissions = missions.filter((mission) => mission.agentId === agent.id);
  const openMissions = agentMissions.filter((mission) => mission.status !== 'complete');
  const completed = agentMissions.filter((mission) => mission.status === 'complete').length;

  const handleDelete = (title: string, missionId: string) => {
    const mission = agentMissions.find((item) => item.id === missionId);
    if (!mission) return;

    Alert.alert('Delete mission?', `"${title}" will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMission(mission) },
    ]);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <DetailHeader title={agent.name} subtitle={agent.role} />

        <ScrollView
          contentContainerStyle={{ padding: spacing.xl, paddingBottom: spacing.xxxl, gap: spacing.lg }}
          showsVerticalScrollIndicator={false}
        >
          <Panel accent={agent.accent} style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
            <View
              style={{
                width: 84,
                height: 84,
                borderRadius: radius.xl,
                alignItems: 'center',
                justifyContent: 'center',
                borderWidth: 1,
                borderColor: `${agent.accent}66`,
                backgroundColor: `${agent.accent}14`,
                shadowColor: agent.accent,
                shadowOpacity: 0.55,
                shadowRadius: 24,
                shadowOffset: { width: 0, height: 0 },
              }}
            >
              <Ionicons name={agent.icon} size={36} color={agent.accent} />
            </View>

            <AppText variant="display" style={{ marginTop: spacing.lg, letterSpacing: 3 }}>
              {agent.name}
            </AppText>
            <AppText variant="micro" style={{ color: agent.accent, marginTop: 4, letterSpacing: 1.6 }}>
              {agent.role.toUpperCase()}
            </AppText>

            <View style={{ marginTop: spacing.md }}>
              <StatusPill
                label={openMissions.length > 0 ? `${openMissions.length} active` : 'Ready'}
                color={openMissions.length > 0 ? agent.accent : colors.textDim}
              />
            </View>
          </Panel>

          <Panel>
            <AppText variant="caption" style={{ fontSize: 13.5, lineHeight: 20 }}>
              {agent.description}
            </AppText>
          </Panel>

          <View>
            <SectionHeader label="Capabilities" />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {agent.capabilities.map((capability) => (
                <Chip key={capability} label={capability} color={agent.accent} />
              ))}
            </View>
          </View>

          <View>
            <SectionHeader label="Assigned missions" />
            {agentMissions.length === 0 ? (
              <EmptyState
                compact
                icon="compass-outline"
                title="No missions assigned"
                body="Nothing has been routed to this specialist yet."
              />
            ) : (
              <View style={{ gap: spacing.sm }}>
                {agentMissions.map((mission) => (
                  <MissionCard
                    key={mission.id}
                    mission={mission}
                    projectName={projects.find((project) => project.id === mission.projectId)?.name}
                    onAdvance={() => {
                      Haptics.selectionAsync().catch(() => {});
                      advanceMission(mission);
                    }}
                    onDelete={() => handleDelete(mission.title, mission.id)}
                  />
                ))}
              </View>
            )}
          </View>

          <View style={{ gap: spacing.sm }}>
            <NeonButton
              label={`Assign a mission to ${agent.name}`}
              icon="add"
              onPress={() => router.push(`/mission-new?agentId=${agent.id}`)}
            />
            <AppText variant="micro" align="center">
              {completed} COMPLETED · {openMissions.length} OPEN
            </AppText>
          </View>
        </ScrollView>
      </SafeAreaView>
    </View>
  );
}
