import React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen } from '@/components/ui/Screen';
import { SectionHeader } from '@/components/ui/Panel';
import { AppText } from '@/components/ui/AppText';
import { FadeInView } from '@/components/ui/FadeInView';
import { AgentCard } from '@/components/nova/AgentCard';
import { AGENTS } from '@/data/agents';
import { useNova } from '@/store/nova-store';
import { spacing } from '@/theme';

export default function AgentsScreen() {
  const router = useRouter();
  const { missions } = useNova();

  const openMissions = missions.filter((mission) => mission.status !== 'complete');
  const [nova, ...specialists] = AGENTS;

  return (
    <Screen
      eyebrow="Agent network"
      title="Agents"
      subtitle="Seven specialists. One intelligence directing them."
    >
      <FadeInView>
        <SectionHeader label="Core" />
        <AgentCard
          agent={nova}
          activeMissions={openMissions.filter((mission) => mission.agentId === nova.id).length}
          onPress={() => router.push(`/agent/${nova.id}`)}
        />
      </FadeInView>

      <FadeInView delay={80} style={{ marginTop: spacing.xxl }}>
        <SectionHeader label="Specialists" />
        <View style={{ gap: spacing.sm }}>
          {specialists.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              activeMissions={openMissions.filter((mission) => mission.agentId === agent.id).length}
              onPress={() => router.push(`/agent/${agent.id}`)}
            />
          ))}
        </View>
      </FadeInView>

      <FadeInView delay={160}>
        <AppText variant="micro" style={{ marginTop: spacing.xl, lineHeight: 16 }}>
          TAP AN AGENT TO CHAT WITH IT, ASSIGN WORK, READ ITS MEMORY OR DISABLE IT. TASK COUNTS COME
          FROM MISSIONS STORED ON THIS DEVICE.
        </AppText>
      </FadeInView>
    </Screen>
  );
}
