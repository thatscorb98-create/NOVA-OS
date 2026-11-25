import React, { useMemo, useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { Screen } from '@/components/ui/Screen';
import { AppText } from '@/components/ui/AppText';
import { Chip } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { IconButton } from '@/components/ui/IconButton';
import { MissionCard } from '@/components/nova/MissionCard';
import { useNova } from '@/store/nova-store';
import { colors, spacing } from '@/theme';
import type { Mission, MissionStatus } from '@/types/nova';

type Filter = 'all' | MissionStatus;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'queued', label: 'Queued' },
  { key: 'active', label: 'Active' },
  { key: 'complete', label: 'Complete' },
];

export default function MissionsScreen() {
  const router = useRouter();
  const { missions, projects, advanceMission, deleteMission } = useNova();
  const [filter, setFilter] = useState<Filter>('all');

  const visible = useMemo(
    () => (filter === 'all' ? missions : missions.filter((mission) => mission.status === filter)),
    [filter, missions],
  );

  const countFor = (key: Filter) =>
    key === 'all' ? missions.length : missions.filter((mission) => mission.status === key).length;

  const handleAdvance = (mission: Mission) => {
    Haptics.selectionAsync().catch(() => {});
    advanceMission(mission);
  };

  const handleDelete = (mission: Mission) => {
    Alert.alert('Delete mission?', `"${mission.title}" will be removed from this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => deleteMission(mission) },
    ]);
  };

  return (
    <Screen
      eyebrow="Operations"
      title="Missions"
      subtitle="Every objective you hand to the network."
      right={
        <IconButton
          icon="add"
          label="Create mission"
          onPress={() => router.push('/mission-new')}
        />
      }
    >
      <FadeInView>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.xl }}
        >
          {FILTERS.map((item) => (
            <Chip
              key={item.key}
              label={`${item.label} ${countFor(item.key)}`}
              active={filter === item.key}
              color={item.key === 'complete' ? colors.emerald : colors.violet}
              onPress={() => setFilter(item.key)}
            />
          ))}
        </ScrollView>
      </FadeInView>

      <View style={{ marginTop: spacing.lg, gap: spacing.sm }}>
        {visible.length === 0 ? (
          <FadeInView delay={80}>
            <EmptyState
              icon="compass-outline"
              title={missions.length === 0 ? 'No missions yet' : 'Nothing in this view'}
              body={
                missions.length === 0
                  ? 'A mission is one clear objective assigned to one specialist. Start with a goal you want handled.'
                  : 'No missions match this filter. Switch back to All to see the full board.'
              }
              actionLabel={missions.length === 0 ? 'Create mission' : undefined}
              onAction={() => router.push('/mission-new')}
            />
          </FadeInView>
        ) : (
          visible.map((mission, index) => (
            <FadeInView key={mission.id} delay={Math.min(index * 40, 200)}>
              <MissionCard
                mission={mission}
                projectName={projects.find((project) => project.id === mission.projectId)?.name}
                onAdvance={() => handleAdvance(mission)}
                onDelete={() => handleDelete(mission)}
              />
            </FadeInView>
          ))
        )}
      </View>

      {missions.length > 0 ? (
        <AppText variant="micro" style={{ marginTop: spacing.xl, lineHeight: 16 }}>
          TAP A MISSION CIRCLE TO MOVE IT QUEUED → ACTIVE → COMPLETE.
        </AppText>
      ) : null}
    </Screen>
  );
}
