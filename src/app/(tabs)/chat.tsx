import React, { useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { AppText } from '@/components/ui/AppText';
import { StatusPill } from '@/components/ui/Bits';
import { Composer } from '@/components/nova/Composer';
import { MessageBubble } from '@/components/nova/MessageBubble';
import { NovaOrb } from '@/components/nova/NovaOrb';
import { CORE_STATUS_COLOR, NOVA_CORE } from '@/lib/nova-core';
import { useNova } from '@/store/nova-store';
import { colors, radius, spacing } from '@/theme';

const SUGGESTIONS = [
  'Plan a product launch',
  'Research my competitors',
  'Draft a business plan',
];

export default function ChatScreen() {
  const { messages, sendChatMessage } = useNova();
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<React.ComponentRef<typeof ScrollView>>(null);

  const handleSend = () => {
    if (!draft.trim()) return;
    sendChatMessage(draft);
    setDraft('');
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
          <View
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
          </View>

          <View style={{ flex: 1 }}>
            <AppText variant="heading">NOVA</AppText>
            <AppText variant="micro" style={{ marginTop: 2 }}>
              CENTRAL INTELLIGENCE
            </AppText>
          </View>

          <StatusPill label={NOVA_CORE.status === 'connected' ? 'Online' : 'Offline'} color={CORE_STATUS_COLOR} />
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
                <NovaOrb size={104} offline={NOVA_CORE.status !== 'connected'} />

                <AppText variant="title" style={{ marginTop: spacing.md }}>
                  Command NOVA
                </AppText>
                <AppText variant="caption" align="center" style={{ maxWidth: 290 }}>
                  One intelligence in front of seven specialists. Goals in, missions out.
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
          </ScrollView>

          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: spacing.xl,
              paddingBottom: spacing.sm,
            }}
          >
            <Ionicons name="lock-closed-outline" size={11} color={colors.textDim} />
            <AppText variant="micro" style={{ flex: 1, fontSize: 9, letterSpacing: 0.8 }}>
              {NOVA_CORE.label} · LIVE REPLIES ENABLE WHEN THE CORE IS CONNECTED
            </AppText>
          </View>

          <Composer value={draft} onChangeText={setDraft} onSend={handleSend} />
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
