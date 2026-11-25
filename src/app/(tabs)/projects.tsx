import React from 'react';
import { Alert, View } from 'react-native';
import { useRouter } from 'expo-router';

import { Screen } from '@/components/ui/Screen';
import { AppText } from '@/components/ui/AppText';
import { EmptyState } from '@/components/ui/EmptyState';
import { FadeInView } from '@/components/ui/FadeInView';
import { IconButton } from '@/components/ui/IconButton';
import { ProjectCard } from '@/components/nova/ProjectCard';
import { useNova } from '@/store/nova-store';
import { spacing } from '@/theme';
import type { Project } from '@/types/nova';

export default function ProjectsScreen() {
  const router = useRouter();
  const { projects, missions, memories, deleteProject } = useNova();

  const handleDelete = (project: Project) => {
    Alert.alert(
      'Delete project?',
      `"${project.name}" will be removed. Its missions stay, but they will no longer be linked.`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => deleteProject(project) },
      ],
    );
  };

  return (
    <Screen
      eyebrow="Portfolio"
      title="Projects"
      subtitle="Group missions into the outcomes they serve."
      right={
        <IconButton icon="add" label="Create project" onPress={() => router.push('/project-new')} />
      }
    >
      {projects.length === 0 ? (
        <FadeInView>
          <EmptyState
            icon="layers-outline"
            title="No projects yet"
            body="A project groups related missions so progress becomes visible as the network works."
            actionLabel="Create project"
            onAction={() => router.push('/project-new')}
          />
        </FadeInView>
      ) : (
        <View style={{ gap: spacing.sm }}>
          {projects.map((project, index) => {
            const linked = missions.filter((mission) => mission.projectId === project.id);

            return (
              <FadeInView key={project.id} delay={Math.min(index * 50, 200)}>
                <ProjectCard
                  project={project}
                  totalMissions={linked.length}
                  completedMissions={linked.filter((mission) => mission.status === 'complete').length}
                  memoryCount={memories.filter((memory) => memory.projectId === project.id).length}
                  onOpenMemory={() => router.push(`/memory?projectId=${project.id}`)}
                  onDelete={() => handleDelete(project)}
                />
              </FadeInView>
            );
          })}
        </View>
      )}

      <AppText variant="micro" style={{ marginTop: spacing.xl, lineHeight: 16 }}>
        LINK A MISSION TO A PROJECT WHEN YOU CREATE IT. PROGRESS IS CALCULATED FROM COMPLETED
        MISSIONS, NOT ESTIMATES.
      </AppText>
    </Screen>
  );
}
