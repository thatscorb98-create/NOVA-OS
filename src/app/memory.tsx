import React, { useMemo, useState } from 'react';
import {
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { AppText } from '@/components/ui/AppText';
import { Chip } from '@/components/ui/Bits';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { IconButton } from '@/components/ui/IconButton';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Screen } from '@/components/ui/Screen';
import { AGENTS, getAgent, isAgentId } from '@/data/agents';
import {
  MEMORY_KINDS,
  MEMORY_SCOPES,
  countMemoriesByScope,
  memoryScopeLabel,
  searchMemories,
} from '@/lib/memory';
import { formatRelative } from '@/lib/time';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';
import type { MemoryKind, MemoryRecord, MemoryScope } from '@/types/nova';

type Filter = 'all' | 'pinned' | MemoryScope;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'global', label: 'Global' },
  { key: 'project', label: 'Projects' },
  { key: 'agent', label: 'Agents' },
  { key: 'conversation', label: 'Chats' },
];

interface MemoryDraft {
  id?: string;
  text: string;
  kind: MemoryKind;
  scope: MemoryScope;
  agentId: string;
  projectId: string;
  pinned: boolean;
}

function scopeMeta(scope: MemoryScope) {
  return MEMORY_SCOPES.find((entry) => entry.key === scope) ?? MEMORY_SCOPES[0];
}

export default function MemoryScreen() {
  const params = useLocalSearchParams<{ agentId?: string; projectId?: string }>();
  const {
    memories,
    projects,
    agents,
    addMemory,
    updateMemory,
    deleteMemory,
    setMemoryPinned,
  } = useNova();

  const [agentFilter, setAgentFilter] = useState<string | undefined>(
    params.agentId && isAgentId(params.agentId) ? params.agentId : undefined,
  );
  const [projectFilter, setProjectFilter] = useState<string | undefined>(params.projectId);
  const [filter, setFilter] = useState<Filter>(
    params.agentId ? 'agent' : params.projectId ? 'project' : 'all',
  );
  const [query, setQuery] = useState('');
  const [draft, setDraft] = useState<MemoryDraft | null>(null);

  const counts = useMemo(() => countMemoriesByScope(memories), [memories]);
  const pinnedCount = memories.filter((memory) => memory.pinned).length;

  const visible = useMemo(() => {
    let list = memories;

    if (agentFilter) {
      list = list.filter((memory) => memory.agentId === agentFilter);
    }
    if (projectFilter) {
      list = list.filter((memory) => memory.projectId === projectFilter);
    }
    if (filter === 'pinned') {
      list = list.filter((memory) => memory.pinned);
    } else if (filter !== 'all') {
      list = list.filter((memory) => memory.scope === filter);
    }

    return searchMemories(list, query, projects)
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
  }, [memories, agentFilter, projectFilter, filter, query, projects]);

  const openCreate = () => {
    const scope: MemoryScope = projectFilter ? 'project' : agentFilter ? 'agent' : 'global';
    setDraft({
      text: '',
      kind: 'fact',
      scope,
      agentId: agentFilter ?? 'nova',
      projectId: projectFilter ?? projects[0]?.id ?? '',
      pinned: false,
    });
  };

  const openEdit = (memory: MemoryRecord) => {
    setDraft({
      id: memory.id,
      text: memory.text,
      kind: memory.kind,
      scope: memory.scope,
      agentId: memory.agentId ?? 'nova',
      projectId: memory.projectId ?? '',
      pinned: memory.pinned,
    });
  };

  const closeDraft = () => setDraft(null);

  const handleSave = () => {
    if (!draft) return;

    const text = draft.text.trim();
    if (!text) {
      Alert.alert('Memory is empty', 'Write the fact you want NOVA to remember.');
      return;
    }

    if (draft.scope === 'project' && !draft.projectId) {
      Alert.alert('Choose a project', 'Project memories must belong to a project.');
      return;
    }

    if (draft.id) {
      updateMemory(draft.id, { text, kind: draft.kind, pinned: draft.pinned });
    } else {
      addMemory({
        text,
        scope: draft.scope,
        kind: draft.kind,
        source: 'user',
        agentId: draft.scope === 'agent' ? (draft.agentId as MemoryRecord['agentId']) : undefined,
        projectId: draft.scope === 'project' ? draft.projectId : undefined,
        pinned: draft.pinned,
      });
    }

    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
    closeDraft();
  };

  const handleDelete = (memory: MemoryRecord) => {
    Alert.alert('Delete memory?', 'NOVA will no longer recall this.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          deleteMemory(memory.id);
          closeDraft();
        },
      },
    ]);
  };

  const togglePin = (memory: MemoryRecord) => {
    setMemoryPinned(memory.id, !memory.pinned);
    Haptics.selectionAsync().catch(() => {});
  };

  const filteredAgent = agentFilter && isAgentId(agentFilter) ? getAgent(agentFilter) : null;
  const filteredProject = projects.find((project) => project.id === projectFilter);

  return (
    <Screen
      eyebrow="Persistent recall"
      title="Memory"
      subtitle="What NOVA and its agents remember, on this device."
      right={<IconButton icon="add" label="Add memory" onPress={openCreate} />}
    >
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <View
          style={{
            flex: 1,
            padding: spacing.md,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.hairline,
            backgroundColor: 'rgba(10, 14, 28, 0.9)',
          }}
        >
          <AppText variant="title" style={{ fontSize: 20, lineHeight: 24 }}>
            {memories.length}
          </AppText>
          <AppText variant="micro">MEMORIES</AppText>
        </View>
        <View
          style={{
            flex: 1,
            padding: spacing.md,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: `${colors.amber}33`,
            backgroundColor: `${colors.amber}0D`,
          }}
        >
          <AppText variant="title" color={colors.amber} style={{ fontSize: 20, lineHeight: 24 }}>
            {pinnedCount}
          </AppText>
          <AppText variant="micro">PINNED</AppText>
        </View>
        <View
          style={{
            flex: 1,
            padding: spacing.md,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.hairline,
            backgroundColor: 'rgba(10, 14, 28, 0.9)',
          }}
        >
          <AppText variant="title" color={colors.cyan} style={{ fontSize: 20, lineHeight: 24 }}>
            {counts.project}
          </AppText>
          <AppText variant="micro">PROJECT</AppText>
        </View>
      </View>

      <View style={{ marginTop: spacing.md, gap: spacing.sm }}>
        <FormField
          label="Search memory"
          placeholder="pricing, audience, decision…"
          value={query}
          onChangeText={setQuery}
          autoCapitalize="none"
        />
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.sm, paddingVertical: spacing.md }}
      >
        {FILTERS.map((item) => (
          <Chip
            key={item.key}
            label={item.label}
            active={filter === item.key}
            color={
              item.key === 'pinned'
                ? colors.amber
                : item.key === 'conversation'
                  ? colors.amber
                  : item.key === 'project'
                    ? colors.cyan
                    : item.key === 'agent'
                      ? colors.emerald
                      : colors.violet
            }
            onPress={() => setFilter(item.key)}
          />
        ))}
      </ScrollView>

      {filteredAgent || filteredProject ? (
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            marginBottom: spacing.md,
          }}
        >
          <AppText variant="micro" style={{ color: filteredAgent?.accent ?? filteredProject?.accent }}>
            SHOWING {filteredAgent ? filteredAgent.name : filteredProject?.name.toUpperCase()} ONLY
          </AppText>
          <Pressable
            onPress={() => {
              setAgentFilter(undefined);
              setProjectFilter(undefined);
              setFilter('all');
            }}
            hitSlop={8}
          >
            <Ionicons name="close-circle" size={14} color={colors.textDim} />
          </Pressable>
        </View>
      ) : null}

      <SectionHeader label={`${visible.length} ${visible.length === 1 ? 'memory' : 'memories'}`} />

      {visible.length === 0 ? (
        <EmptyState
          icon="library-outline"
          title={memories.length === 0 ? 'Nothing remembered yet' : 'No matches'}
          body={
            memories.length === 0
              ? 'Agents save facts as they work, and completed missions write memory automatically. You can also add one yourself.'
              : 'No memory matches this search and filter. Clear the search or switch filters.'
          }
          actionLabel={memories.length === 0 ? 'Add memory' : undefined}
          onAction={openCreate}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {visible.map((memory) => {
            const meta = scopeMeta(memory.scope);

            return (
              <Panel key={memory.id} style={{ gap: spacing.sm }} accent={memory.pinned ? colors.amber : undefined}>
                <Pressable onPress={() => openEdit(memory)} style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                      <Ionicons name={meta.icon} size={11} color={meta.color} />
                      <AppText variant="micro" style={{ color: meta.color }}>
                        {memoryScopeLabel(memory, projects).toUpperCase()}
                      </AppText>
                    </View>
                    <AppText variant="micro">{memory.kind.toUpperCase()}</AppText>
                    <AppText variant="micro">{memory.source.toUpperCase()}</AppText>
                    <AppText variant="micro">{formatRelative(memory.updatedAt).toUpperCase()}</AppText>
                  </View>

                  <AppText variant="body" style={{ marginTop: spacing.sm, fontSize: 13.5, lineHeight: 20 }}>
                    {memory.text}
                  </AppText>
                </Pressable>

                <View
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: spacing.lg,
                    borderTopWidth: 1,
                    borderTopColor: colors.hairline,
                    paddingTop: spacing.sm,
                  }}
                >
                  <Pressable onPress={() => togglePin(memory)} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ionicons
                      name={memory.pinned ? 'bookmark' : 'bookmark-outline'}
                      size={14}
                      color={memory.pinned ? colors.amber : colors.textDim}
                    />
                    <AppText variant="micro" style={{ color: memory.pinned ? colors.amber : colors.textDim }}>
                      {memory.pinned ? 'PINNED' : 'PIN'}
                    </AppText>
                  </Pressable>

                  <Pressable onPress={() => openEdit(memory)} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ionicons name="create-outline" size={14} color={colors.textMuted} />
                    <AppText variant="micro">EDIT</AppText>
                  </Pressable>

                  <Pressable onPress={() => handleDelete(memory)} hitSlop={8} style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    <Ionicons name="trash-outline" size={14} color={colors.danger} />
                    <AppText variant="micro" style={{ color: colors.danger }}>
                      DELETE
                    </AppText>
                  </Pressable>
                </View>
              </Panel>
            );
          })}
        </View>
      )}

      <AppText variant="micro" style={{ marginTop: spacing.xl, lineHeight: 16 }}>
        MEMORY IS STORED ON THIS PHONE AND SURVIVES RESTARTS. RELEVANT ENTRIES ARE RECALLED INTO THE
        PROMPT ON EVERY TURN; PINNED ENTRIES ARE ALWAYS INCLUDED.
      </AppText>

      <Modal visible={Boolean(draft)} transparent animationType="fade" onRequestClose={closeDraft}>
        <KeyboardAvoidingView
          style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(2, 4, 10, 0.78)' }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <Pressable style={{ flex: 1 }} onPress={closeDraft} accessibilityLabel="Close editor" />

          <View
            style={{
              maxHeight: '88%',
              borderTopLeftRadius: radius.xl,
              borderTopRightRadius: radius.xl,
              borderWidth: 1,
              borderColor: colors.panelBorder,
              backgroundColor: '#070A15',
              paddingBottom: spacing.xl,
            }}
          >
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
              <AppText variant="heading">{draft?.id ? 'Edit memory' : 'New memory'}</AppText>
              <Pressable onPress={closeDraft} hitSlop={10}>
                <Ionicons name="close" size={20} color={colors.textMuted} />
              </Pressable>
            </View>

            {draft ? (
              <ScrollView
                contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }}
                keyboardShouldPersistTaps="handled"
                showsVerticalScrollIndicator={false}
              >
                <FormField
                  label="Memory"
                  placeholder="A fact, preference or decision NOVA should remember…"
                  value={draft.text}
                  onChangeText={(text) => setDraft({ ...draft, text })}
                  multiline
                  maxLength={1000}
                  autoFocus={!draft.id}
                />

                <View style={{ gap: spacing.sm }}>
                  <AppText variant="label">KIND</AppText>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                    {MEMORY_KINDS.map((kind) => (
                      <Chip
                        key={kind.key}
                        label={kind.label}
                        active={draft.kind === kind.key}
                        onPress={() => setDraft({ ...draft, kind: kind.key })}
                      />
                    ))}
                  </View>
                </View>

                {draft.id ? (
                  <View style={{ gap: spacing.sm }}>
                    <AppText variant="label">SCOPE</AppText>
                    <AppText variant="caption">
                      {memoryScopeLabel(
                        {
                          id: draft.id,
                          text: draft.text,
                          scope: draft.scope,
                          kind: draft.kind,
                          source: 'user',
                          agentId: draft.agentId as MemoryRecord['agentId'],
                          projectId: draft.scope === 'project' ? draft.projectId : undefined,
                          tags: [],
                          pinned: draft.pinned,
                          createdAt: 0,
                          updatedAt: 0,
                        },
                        projects,
                      )}
                      {' · scope is fixed after creation'}
                    </AppText>
                  </View>
                ) : (
                  <>
                    <View style={{ gap: spacing.sm }}>
                      <AppText variant="label">SCOPE</AppText>
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                        {MEMORY_SCOPES.filter((scope) => scope.key !== 'conversation').map((scope) => (
                          <Chip
                            key={scope.key}
                            label={scope.label}
                            color={scope.color}
                            active={draft.scope === scope.key}
                            onPress={() => setDraft({ ...draft, scope: scope.key })}
                          />
                        ))}
                      </View>
                    </View>

                    {draft.scope === 'agent' ? (
                      <View style={{ gap: spacing.sm }}>
                        <AppText variant="label">AGENT</AppText>
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                          {AGENTS.map((agent) => (
                            <Chip
                              key={agent.id}
                              label={agent.name}
                              color={agent.accent}
                              active={draft.agentId === agent.id}
                              onPress={() => setDraft({ ...draft, agentId: agent.id })}
                            />
                          ))}
                        </View>
                      </View>
                    ) : null}

                    {draft.scope === 'project' ? (
                      <View style={{ gap: spacing.sm }}>
                        <AppText variant="label">PROJECT</AppText>
                        {projects.length === 0 ? (
                          <AppText variant="caption">
                            Create a project first — project memory needs a project to belong to.
                          </AppText>
                        ) : (
                          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                            {projects.map((project) => (
                              <Chip
                                key={project.id}
                                label={project.name}
                                color={project.accent}
                                active={draft.projectId === project.id}
                                onPress={() => setDraft({ ...draft, projectId: project.id })}
                              />
                            ))}
                          </View>
                        )}
                      </View>
                    ) : null}
                  </>
                )}

                <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                  <View style={{ flex: 1 }}>
                    <AppText variant="bodyStrong" style={{ fontSize: 13 }}>
                      Pin to every prompt
                    </AppText>
                    <AppText variant="micro" style={{ marginTop: 2 }}>
                      PINNED MEMORIES ARE ALWAYS RECALLED
                    </AppText>
                  </View>
                  <Switch
                    value={draft.pinned}
                    onValueChange={(pinned) => setDraft({ ...draft, pinned })}
                    trackColor={{ false: '#1A2036', true: `${colors.amber}99` }}
                    thumbColor={draft.pinned ? colors.amber : '#8A93B8'}
                  />
                </View>

                <NeonButton
                  label={draft.id ? 'Save changes' : 'Save memory'}
                  icon="save-outline"
                  onPress={handleSave}
                  disabled={!draft.text.trim()}
                />

                {draft.id ? (
                  <NeonButton
                    label="Delete memory"
                    icon="trash-outline"
                    variant="danger"
                    onPress={() => {
                      const memory = memories.find((entry) => entry.id === draft.id);
                      if (memory) handleDelete(memory);
                    }}
                  />
                ) : null}
              </ScrollView>
            ) : null}
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </Screen>
  );
}
