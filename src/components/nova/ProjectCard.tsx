import React from 'react';
import { Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { Panel } from '@/components/ui/Panel';
import { colors, radius, spacing } from '@/theme';
import { formatRelative } from '@/lib/time';
import type { Project } from '@/types/nova';

interface ProjectCardProps {
  project: Project;
  totalMissions: number;
  completedMissions: number;
  onDelete: () => void;
}

export function ProjectCard({
  project,
  totalMissions,
  completedMissions,
  onDelete,
}: ProjectCardProps) {
  const progress = totalMissions === 0 ? 0 : completedMissions / totalMissions;

  return (
    <Panel accent={project.accent} style={{ padding: spacing.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }}>
        <View
          style={{
            width: 34,
            height: 34,
            borderRadius: radius.sm,
            backgroundColor: `${project.accent}1A`,
            borderWidth: 1,
            borderColor: `${project.accent}44`,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Ionicons name="layers-outline" size={16} color={project.accent} />
        </View>

        <View style={{ flex: 1 }}>
          <AppText variant="heading">{project.name}</AppText>
          {project.description ? (
            <AppText variant="caption" numberOfLines={2} style={{ marginTop: 4 }}>
              {project.description}
            </AppText>
          ) : null}
        </View>

        <Pressable
          onPress={onDelete}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={`Delete project ${project.name}`}
          style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
        >
          <Ionicons name="trash-outline" size={16} color={colors.textDim} />
        </Pressable>
      </View>

      <View style={{ marginTop: spacing.lg }}>
        <View
          style={{
            height: 4,
            borderRadius: 2,
            backgroundColor: 'rgba(255,255,255,0.06)',
            overflow: 'hidden',
          }}
        >
          <View
            style={{
              width: `${Math.min(100, Math.round(progress * 100))}%`,
              height: '100%',
              borderRadius: 2,
              backgroundColor: project.accent,
            }}
          />
        </View>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginTop: spacing.sm,
          }}
        >
          <AppText variant="micro">
            {totalMissions === 0
              ? 'NO MISSIONS LINKED'
              : `${completedMissions}/${totalMissions} MISSIONS COMPLETE`}
          </AppText>
          <AppText variant="micro">{formatRelative(project.createdAt).toUpperCase()}</AppText>
        </View>
      </View>
    </Panel>
  );
}
