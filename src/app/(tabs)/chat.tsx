import React, { useRef, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';
import { useRouter } from 'expo-router';

import { AppText } from '@/components/ui/AppText';
import { StatusPill } from '@/components/ui/Bits';
import { Composer } from '@/components/nova/Composer';
import { MessageBubble } from '@/components/nova/MessageBubble';
import { NovaOrb } from '@/components/nova/NovaOrb';
import { useAgentRuntime } from '@/store/agent-runtime';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';

const SUGGESTIONS = [
  'Research my top 3 competitors and brief me',
  'Plan a launch for my product',
  'Draft next week’s content calendar',
];

export default function ChatScreen() {
  const router = useRouter();
  const { messages } = useNova();
  const runtime = useAgentRuntime();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const working = runtime.isBusy('nova');
  const online = runtime.hasKey;

  const handleSend = () => {
    if (!draft.trim() || working) return;
    const text = draft.trim();
    setDraft('');
    void runtime.sendNovaMessage(text);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(34, 211, 238, 0.08)', 'transparent']}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, height: 220 }}
      />
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.md,
            paddingHorizontal: spacing.xl,
            paddingVertical: spacing.md,
            borderBottomWidth: 1,
            borderBottomColor: colors.hairline,
          }}
        >
          <Pressable
            onPress={() => router.push('/core')}
            accessibilityRole="button"
            accessibilityLabel="Core settings"
            style={{
              width: 40,
              height: 40,
              borderRadius: radius.pill,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: 1,
              borderColor: 'rgba(139, 92, 246, 0.45)',
              overflow: 'hidden',
            }}
          >
            <LinearGradient
              colors={['#2A1857', '#0A0D1C']}
              style={{ flex: 1, alignItems: 'center', justifyContent: 'center', alignSelf: 'stretch' }}
            >
              <View
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: 5,
                  backgroundColor: colors.cyanBright,
                  shadowColor: colors.cyan,
                  shadowOpacity: 0.9,
                  shadowRadius: 8,
                  shadowOffset: { width: 0, height: 0 },
                }}
              />
            </LinearGradient>
          </Pressable>

          <View style={{ flex: 1 }}>
            <AppText variant="heading">NOVA</AppText>
            <AppText variant="micro" style={{ marginTop: 2 }}>
              CENTRAL INTELLIGENCE
            </AppText>
          </View>

          <StatusPill
            label={online ? 'Online' : 'Offline'}
            color={online ? colors.success : colors.amber}
          />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            ref={scrollRef}
            contentContainerStyle={{
              padding: spacing.xl,
              gap: spacing.md,
              flexGrow: 1,
            }}
            onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: true })}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            {messages.length === 0 ? (
              <View
                style={{
                  flex: 1,
                  alignItems: 'center',
                  justifyContent: 'center',
                  paddingVertical: spacing.xl,
                  gap: spacing.sm,
                }}
              >
                <NovaOrb size={104} offline={!online} />

                <AppText variant="title" style={{ marginTop: spacing.md }}>
                  Command NOVA
                </AppText>
                <AppText variant="caption" align="center" style={{ maxWidth: 290 }}>
                  One intelligence in front of six specialists. Give NOVA a goal and it delegates
                  the work to the right agent.
                </AppText>

                <View
                  style={{
                    flexDirection: 'row',
                    flexWrap: 'wrap',
                    justifyContent: 'center',
                    gap: spacing.sm,
                    marginTop: spacing.lg,
                  }}
                >
                  {SUGGESTIONS.map((suggestion) => (
                    <Pressable
                      key={suggestion}
                      onPress={() => setDraft(suggestion)}
                      style={({ pressed }) => ({
                        paddingHorizontal: spacing.md,
                        paddingVertical: spacing.sm,
                        borderRadius: radius.pill,
                        borderWidth: 1,
                        borderColor: colors.hairline,
                        backgroundColor: 'rgba(255,255,255,0.02)',
                        opacity: pressed ? 0.65 : 1,
                      })}
                    >
                      <AppText variant="caption" style={{ fontSize: 12 }}>
                        {suggestion}
                      </AppText>
                    </Pressable>
                  ))}
                </View>
              </View>
            ) : (
              messages.map((message) => <MessageBubble key={message.id} message={message} />)
            )}

            {working ? (
              <View
                style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: spacing.sm,
                  paddingVertical: spacing.sm,
                }}
              >
                <ActivityIndicator size="small" color={colors.cyan} />
                <AppText variant="micro">NOVA IS WORKING…</AppText>
              </View>
            ) : null}
          </ScrollView>

          <Pressable
            onPress={() => router.push('/core')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: spacing.xl,
              paddingBottom: spacing.sm,
            }}
          >
            <Ionicons
              name={online ? 'flash-outline' : 'lock-closed-outline'}
              size={11}
              color={online ? colors.success : colors.amber}
            />
            <AppText
              variant="micro"
              style={{
                flex: 1,
                fontSize: 9,
                letterSpacing: 0.8,
                color: online ? colors.textDim : colors.amber,
              }}
            >
              {online
                ? `${runtime.model} · LIVE CALLS · TAP FOR CORE SETTINGS`
                : 'CORE OFFLINE · TAP TO ADD YOUR NVIDIA API KEY'}
            </AppText>
          </Pressable>

          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={handleSend}
            placeholder={online ? 'Command NOVA…' : 'Connect the core to chat…'}
          />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
