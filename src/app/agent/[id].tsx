import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusPill } from '@/components/ui/Bits';
import { DetailHeader } from '@/components/ui/DetailHeader';
import { EmptyState } from '@/components/ui/EmptyState';
import { FormField } from '@/components/ui/FormField';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { Composer } from '@/components/nova/Composer';
import { MISSION_STATUS_META } from '@/components/nova/MissionCard';
import { MessageBubble } from '@/components/nova/MessageBubble';
import { getAgent, isAgentId } from '@/data/agents';
import { formatRelative } from '@/lib/time';
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';
import type { Mission } from '@/types/nova';

type Tab = 'overview' | 'work' | 'chat';

const TABS: { key: Tab; label: string }[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'work', label: 'Work' },
  { key: 'chat', label: 'Chat' },
];

const SUGGESTIONS = [
  'What can you do for my current project?',
  'Review my open missions and name the biggest risk.',
  'What should I do next?',
];

export default function AgentScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const agentId = params.id && isAgentId(params.id) ? params.id : 'nova';
  const agent = getAgent(agentId);

  const {
    missions,
    projects,
    threads,
    memory,
    agents,
    setAgentEnabled,
    clearThread,
    addMemoryNote,
    createMission,
  } = useNova();
  const runtime = useAgentRuntime();

  const [tab, setTab] = useState<Tab>('overview');
  const [title, setTitle] = useState('');
  const [objective, setObjective] = useState('');
  const [note, setNote] = useState('');
  const [draft, setDraft] = useState('');
  const [assigning, setAssigning] = useState(false);

  const chatRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const enabled = agents[agent.id]?.enabled !== false;
  const thread = threads[agent.id] ?? [];
  const notes = (memory[agent.id]?.notes ?? []).slice().reverse();
  const agentMissions = missions.filter((mission) => mission.agentId === agent.id);
  const completed = agentMissions.filter((mission) => mission.result).length;
  const open = agentMissions.filter((mission) => mission.status !== 'complete').length;
  const chatting = runtime.isBusy(`agent:${agent.id}`);

  const handleToggle = (value: boolean) => {
    setAgentEnabled(agent.id, value);
    Haptics.selectionAsync().catch(() => {});
  };

  const handleAssign = async () => {
    if (!enabled) {
      Alert.alert(`${agent.name} is disabled`, 'Enable the agent with the switch above first.');
      return;
    }

    if (!title.trim()) {
      Alert.alert('Add a task title', 'A short title makes the work easy to find later.');
      return;
    }

    setAssigning(true);
    const result = await runtime.assignAndRun({
      agentId: agent.id,
      title: title.trim(),
      objective: objective.trim(),
    });
    setAssigning(false);

    if (!result.ok) {
      Alert.alert(`${agent.name} could not finish`, result.error ?? 'Unknown error');
      return;
    }

    setTitle('');
    setObjective('');
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});

    if (result.missionId) {
      router.push(`/mission/${result.missionId}`);
    }
  };

  const handleQueueOnly = () => {
    if (!title.trim()) {
      Alert.alert('Add a task title first');
      return;
    }

    const mission = createMission({
      agentId: agent.id,
      title: title.trim(),
      objective: objective.trim(),
    });
    setTitle('');
    setObjective('');
    router.push(`/mission/${mission.id}`);
  };

  const handleSend = () => {
    const text = draft.trim();
    if (!text || chatting || !enabled) return;
    setDraft('');
    void runtime.sendAgentMessage(agent.id, text);
  };

  const handleRemember = () => {
    if (!note.trim()) return;
    addMemoryNote(agent.id, note, 'user');
    setNote('');
    Haptics.selectionAsync().catch(() => {});
  };

  const handleRun = async (mission: Mission) => {
    setTab('work');
    const result = await runtime.runMission(mission.id);
    if (!result.ok) {
      Alert.alert(`${agent.name} could not finish`, result.error ?? 'Unknown error');
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <DetailHeader
          title={agent.name}
          subtitle={agent.role}
          right={
            <View style={{ alignItems: 'center', gap: 2 }}>
              <Switch
                value={enabled}
                onValueChange={handleToggle}
                trackColor={{ false: '#1A2036', true: `${agent.accent}99` }}
                thumbColor={enabled ? agent.accent : '#8A93B8'}
                accessibilityLabel={`${enabled ? 'Disable' : 'Enable'} ${agent.name}`}
              />
              <AppText variant="micro" style={{ color: enabled ? agent.accent : colors.textDim }}>
                {enabled ? 'ON' : 'OFF'}
              </AppText>
            </View>
          }
        />

        <View
          style={{
            flexDirection: 'row',
            gap: spacing.xs,
            paddingHorizontal: spacing.xl,
            paddingBottom: spacing.md,
          }}
        >
          {TABS.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => setTab(item.key)}
              accessibilityRole="tab"
              accessibilityState={{ selected: tab === item.key }}
              style={({ pressed }) => ({
                flex: 1,
                paddingVertical: 9,
                borderRadius: radius.pill,
                alignItems: 'center',
                borderWidth: 1,
                borderColor: tab === item.key ? `${agent.accent}88` : colors.hairline,
                backgroundColor:
                  tab === item.key ? `${agent.accent}1F` : 'rgba(255,255,255,0.015)',
                opacity: pressed ? 0.75 : 1,
              })}
            >
              <AppText
                variant="micro"
                style={{
                  color: tab === item.key ? agent.accent : colors.textMuted,
                  letterSpacing: 1.2,
                }}
              >
                {item.label.toUpperCase()}
                {item.key === 'work' ? ` ${agentMissions.length}` : ''}
                {item.key === 'chat' ? ` ${thread.length}` : ''}
              </AppText>
            </Pressable>
          ))}
        </View>

        {!enabled ? (
          <View
            style={{
              marginHorizontal: spacing.xl,
              marginBottom: spacing.sm,
              padding: spacing.md,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: `${colors.amber}44`,
              backgroundColor: `${colors.amber}10`,
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
            }}
          >
            <Ionicons name="pause-circle-outline" size={15} color={colors.amber} />
            <AppText variant="caption" style={{ flex: 1, fontSize: 12 }}>
              {agent.name} is disabled. NOVA cannot delegate to it and it cannot run missions.
            </AppText>
          </View>
        ) : null}

        {tab === 'chat' ? (
          <KeyboardAvoidingView
            style={{ flex: 1 }}
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          >
            <View
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                justifyContent: 'space-between',
                paddingHorizontal: spacing.xl,
                paddingBottom: spacing.sm,
              }}
            >
              <AppText variant="micro">
                {runtime.hasKey ? `LIVE · ${runtime.model.split('/')[1] ?? runtime.model}` : 'CORE OFFLINE'}
              </AppText>
              {thread.length > 0 ? (
                <Pressable
                  onPress={() => {
                    Alert.alert('Clear conversation?', `The chat with ${agent.name} will be erased.`, [
                      { text: 'Cancel', style: 'cancel' },
                      { text: 'Clear', style: 'destructive', onPress: () => clearThread(agent.id) },
                    ]);
                  }}
                  hitSlop={8}
                >
                  <AppText variant="micro" style={{ color: colors.textMuted }}>
                    CLEAR
                  </AppText>
                </Pressable>
              ) : null}
            </View>

            <ScrollView
              ref={chatRef}
              contentContainerStyle={{
                paddingHorizontal: spacing.xl,
                paddingBottom: spacing.lg,
                gap: spacing.md,
                flexGrow: 1,
              }}
              onContentSizeChange={() => chatRef.current?.scrollToEnd({ animated: true })}
              keyboardShouldPersistTaps="handled"
              showsVerticalScrollIndicator={false}
            >
              {thread.length === 0 ? (
                <View style={{ gap: spacing.md, paddingTop: spacing.md }}>
                  <Panel accent={agent.accent}>
                    <AppText variant="body" style={{ lineHeight: 21 }}>
                      You are talking directly to {agent.name}. Every reply is a real model call
                      using this agent&apos;s own instructions and memory — no scripted answers.
                    </AppText>
                  </Panel>
                  <View style={{ gap: spacing.sm }}>
                    {SUGGESTIONS.map((suggestion) => (
                      <Pressable
                        key={suggestion}
                        onPress={() => setDraft(suggestion)}
                        style={({ pressed }) => ({
                          padding: spacing.md,
                          borderRadius: radius.md,
                          borderWidth: 1,
                          borderColor: colors.hairline,
                          backgroundColor: 'rgba(255,255,255,0.02)',
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        <AppText variant="caption">{suggestion}</AppText>
                      </Pressable>
                    ))}
                  </View>
                </View>
              ) : (
                thread.map((message) => <MessageBubble key={message.id} message={message} />)
              )}

              {chatting ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <ActivityIndicator size="small" color={agent.accent} />
                  <AppText variant="micro">{agent.name} IS THINKING…</AppText>
                </View>
              ) : null}
            </ScrollView>

            <Composer
              value={draft}
              onChangeText={setDraft}
              onSend={handleSend}
              placeholder={enabled ? `Message ${agent.name}…` : `${agent.name} is disabled`}
            />
          </KeyboardAvoidingView>
        ) : (
          <ScrollView
            contentContainerStyle={{
              paddingHorizontal: spacing.xl,
              paddingBottom: spacing.xxxl,
              gap: spacing.lg,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {tab === 'overview' ? (
              <>
                <Panel accent={agent.accent} style={{ alignItems: 'center', paddingVertical: spacing.xxl }}>
                  <View
                    style={{
                      width: 72,
                      height: 72,
                      borderRadius: radius.xl,
                      alignItems: 'center',
                      justifyContent: 'center',
                      borderWidth: 1,
                      borderColor: `${agent.accent}66`,
                      backgroundColor: `${agent.accent}14`,
                    }}
                  >
                    <Ionicons name={agent.icon} size={30} color={agent.accent} />
                  </View>

                  <AppText variant="display" style={{ marginTop: spacing.md, letterSpacing: 3 }}>
                    {agent.name}
                  </AppText>
                  <AppText variant="micro" style={{ color: agent.accent, marginTop: 4 }}>
                    {agent.role.toUpperCase()}
                  </AppText>

                  <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md }}>
                    <StatusPill
                      label={enabled ? (open > 0 ? `${open} open` : 'Ready') : 'Disabled'}
                      color={enabled ? agent.accent : colors.textDim}
                    />
                    <StatusPill label={`${completed} delivered`} color={colors.success} />
                  </View>

                  <AppText variant="caption" align="center" style={{ marginTop: spacing.md }}>
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
                  <SectionHeader label="Assign a task" />
                  <Panel style={{ gap: spacing.md }}>
                    <FormField
                      label="Task title"
                      placeholder="e.g. Audit the pricing page"
                      value={title}
                      onChangeText={setTitle}
                      maxLength={120}
                    />
                    <FormField
                      label="Brief"
                      placeholder="Context, constraints and what finished work looks like…"
                      value={objective}
                      onChangeText={setObjective}
                      multiline
                      maxLength={2000}
                    />
                    <NeonButton
                      label={assigning ? 'Working…' : `Assign & run with ${agent.name}`}
                      icon="flash-outline"
                      onPress={handleAssign}
                      loading={assigning}
                      disabled={!enabled || assigning || !runtime.hasKey}
                    />
                    <NeonButton
                      label="Queue without running"
                      icon="time-outline"
                      variant="ghost"
                      onPress={handleQueueOnly}
                      disabled={!enabled}
                    />
                    {!runtime.hasKey ? (
                      <Pressable onPress={() => router.push('/core')}>
                        {({ pressed }) => (
                          <AppText
                            variant="micro"
                            align="center"
                            style={{ color: pressed ? colors.cyanBright : colors.amber }}
                          >
                            CORE OFFLINE · TAP TO ADD YOUR NVIDIA KEY
                          </AppText>
                        )}
                      </Pressable>
                    ) : (
                      <AppText variant="micro" align="center">
                        RUNS ON {runtime.model.split('/')[1]?.toUpperCase() ?? runtime.model}
                      </AppText>
                    )}
                  </Panel>
                </View>

                <View>
                  <SectionHeader label={`Memory ${notes.length > 0 ? `· ${notes.length}` : ''}`} />
                  <Panel style={{ gap: spacing.md }}>
                    {notes.length === 0 ? (
                      <AppText variant="caption">
                        {agent.name} has not saved anything yet. Notes are written automatically
                        after completed missions, and the agent can save its own.
                      </AppText>
                    ) : (
                      <View style={{ gap: spacing.sm }}>
                        {notes.slice(0, 6).map((entry) => (
                          <View
                            key={entry.id}
                            style={{
                              borderLeftWidth: 2,
                              borderLeftColor: `${agent.accent}66`,
                              paddingLeft: spacing.md,
                              gap: 3,
                            }}
                          >
                            <AppText variant="caption" style={{ fontSize: 12 }}>
                              {entry.text}
                            </AppText>
                            <AppText variant="micro">
                              {entry.source.toUpperCase()} · {formatRelative(entry.createdAt).toUpperCase()}
                            </AppText>
                          </View>
                        ))}
                      </View>
                    )}

                    <FormField
                      label="Teach a fact"
                      placeholder="Something this agent should always remember"
                      value={note}
                      onChangeText={setNote}
                      maxLength={400}
                    />
                    <NeonButton
                      label="Save to memory"
                      icon="bookmark-outline"
                      variant="ghost"
                      onPress={handleRemember}
                      disabled={!note.trim()}
                    />
                  </Panel>
                </View>

                <View>
                  <SectionHeader
                    label="Recent work"
                    actionLabel={agentMissions.length > 0 ? 'Open work' : undefined}
                    onAction={agentMissions.length > 0 ? () => setTab('work') : undefined}
                  />
                  {agentMissions.length === 0 ? (
                    <EmptyState
                      compact
                      icon="compass-outline"
                      title="Nothing assigned yet"
                      body={`Give ${agent.name} a task above and the finished work is stored here.`}
                    />
                  ) : (
                    <View style={{ gap: spacing.sm }}>
                      {agentMissions.slice(0, 3).map((mission) => {
                        const meta = MISSION_STATUS_META[mission.status];
                        return (
                          <Panel
                            key={mission.id}
                            onPress={() => router.push(`/mission/${mission.id}`)}
                            style={{ gap: 4 }}
                          >
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                              <AppText variant="bodyStrong" numberOfLines={1} style={{ flex: 1 }}>
                                {mission.title}
                              </AppText>
                              <AppText variant="micro" style={{ color: meta.color }}>
                                {meta.label.toUpperCase()}
                              </AppText>
                            </View>
                            <AppText variant="caption" numberOfLines={mission.result ? 3 : 1}>
                              {mission.result?.text ?? mission.objective ?? 'No brief provided.'}
                            </AppText>
                          </Panel>
                        );
                      })}
                    </View>
                  )}
                </View>
              </>
            ) : (
              <>
                <SectionHeader
                  label="Delivered work"
                  actionLabel={`Assign new`}
                  onAction={() => setTab('overview')}
                />
                {agentMissions.length === 0 ? (
                  <EmptyState
                    icon="document-text-outline"
                    title="No work yet"
                    body={`Tasks you assign to ${agent.name} appear here with their model output.`}
                    actionLabel="Assign a task"
                    onAction={() => setTab('overview')}
                  />
                ) : (
                  <View style={{ gap: spacing.sm }}>
                    {agentMissions.map((mission) => {
                      const meta = MISSION_STATUS_META[mission.status];
                      const busy = runtime.isBusy(`mission:${mission.id}`);

                      return (
                        <Panel key={mission.id} accent={mission.result ? colors.success : undefined}>
                          <View style={{ gap: spacing.sm }}>
                            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                              <AppText
                                variant="bodyStrong"
                                style={{ flex: 1 }}
                                numberOfLines={2}
                              >
                                {mission.title}
                              </AppText>
                              <AppText variant="micro" style={{ color: meta.color }}>
                                {meta.label.toUpperCase()}
                              </AppText>
                            </View>

                            {mission.result ? (
                              <AppText variant="caption" numberOfLines={4}>
                                {mission.result.text}
                              </AppText>
                            ) : (
                              <AppText variant="caption" numberOfLines={2}>
                                {mission.objective || 'No brief provided.'}
                              </AppText>
                            )}

                            <View
                              style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: spacing.sm,
                                flexWrap: 'wrap',
                              }}
                            >
                              <AppText variant="micro">
                                {formatRelative(mission.createdAt).toUpperCase()}
                              </AppText>
                              {mission.result ? (
                                <AppText variant="micro" style={{ color: colors.success }}>
                                  {Math.max(1, Math.round(mission.result.durationMs / 1000))}S ·{' '}
                                  {mission.result.model.split('/')[1]?.toUpperCase() ?? 'MODEL'}
                                </AppText>
                              ) : null}
                              {projects.find((project) => project.id === mission.projectId) ? (
                                <AppText variant="micro">
                                  {projects
                                    .find((project) => project.id === mission.projectId)
                                    ?.name.toUpperCase()}
                                </AppText>
                              ) : null}
                            </View>

                            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                              <View style={{ flex: 1 }}>
                                <NeonButton
                                  label={busy ? 'Working…' : mission.result ? 'Run again' : 'Run'}
                                  icon={mission.result ? 'refresh' : 'play'}
                                  variant="ghost"
                                  loading={busy}
                                  disabled={busy || !enabled || !runtime.hasKey}
                                  onPress={() => {
                                    void handleRun(mission);
                                  }}
                                />
                              </View>
                              <View style={{ flex: 1 }}>
                                <NeonButton
                                  label="Open"
                                  icon="open-outline"
                                  variant="ghost"
                                  onPress={() => router.push(`/mission/${mission.id}`)}
                                />
                              </View>
                            </View>
                          </View>
                        </Panel>
                      );
                    })}
                  </View>
                )}
              </>
            )}
          </ScrollView>
        )}
      </SafeAreaView>
    </View>
  );
}
