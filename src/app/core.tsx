import React, { useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Linking,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';

import { AppText } from '@/components/ui/AppText';
import { Chip, StatusDot } from '@/components/ui/Bits';
import { DetailHeader } from '@/components/ui/DetailHeader';
import { FormField } from '@/components/ui/FormField';
import { NeonButton } from '@/components/ui/NeonButton';
import { Panel, SectionHeader } from '@/components/ui/Panel';
import { NIM_KEY_HELP_URL, NIM_MODELS } from '@/lib/model/models';
import { useAgentRuntime } from '@/store/agent-runtime';
import { colors, radius, spacing } from '@/theme';

type Tone = 'ok' | 'error';

export default function CoreScreen() {
  const runtime = useAgentRuntime();
  const { hasKey, keyLoaded, model, setModel, saveKey, removeKey, testConnection } = runtime;

  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [status, setStatus] = useState<{ tone: Tone; text: string } | null>(null);

  const handleSave = async () => {
    if (!draft.trim()) {
      setStatus({ tone: 'error', text: 'Paste your NVIDIA API key first.' });
      return;
    }

    setSaving(true);
    setStatus(null);
    const result = await saveKey(draft);
    setSaving(false);

    if (!result.ok) {
      setStatus({ tone: 'error', text: result.error ?? 'Could not save the key.' });
      return;
    }

    setDraft('');
    setStatus({ tone: 'ok', text: 'Key saved in this device’s encrypted keystore.' });
  };

  const handleTest = async () => {
    setTesting(true);
    setStatus(null);
    const result = await testConnection();
    setTesting(false);

    if (result.ok) {
      setStatus({
        tone: 'ok',
        text: `Connected. ${model.split('/')[1] ?? model} replied: “${result.text ?? ''}”`,
      });
    } else {
      setStatus({ tone: 'error', text: result.error ?? 'The connection test failed.' });
    }
  };

  const handleRemove = () => {
    Alert.alert('Remove API key?', 'Live model calls stop until you add a key again.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: () => {
          void removeKey();
          setStatus({ tone: 'ok', text: 'Key removed from this device.' });
        },
      },
    ]);
  };

  const openKeyPage = () => {
    Linking.openURL(NIM_KEY_HELP_URL).catch(() => {
      Alert.alert('Could not open the browser', NIM_KEY_HELP_URL);
    });
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <SafeAreaView edges={['top', 'left', 'right']} style={{ flex: 1 }}>
        <DetailHeader title="Core" subtitle="Model access" />

        <KeyboardAvoidingView
          style={{ flex: 1 }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView
            contentContainerStyle={{
              padding: spacing.xl,
              paddingBottom: spacing.xxxl,
              gap: spacing.lg,
            }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <Panel accent={hasKey ? colors.success : colors.amber}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <StatusDot color={hasKey ? colors.success : colors.amber} size={7} />
                <AppText variant="heading">
                  {keyLoaded && hasKey ? 'CORE ONLINE' : 'CORE OFFLINE'}
                </AppText>
              </View>
              <AppText variant="caption" style={{ marginTop: spacing.sm }}>
                {hasKey
                  ? 'A key is stored on this device. Every agent conversation and mission runs through NVIDIA NIM with real requests.'
                  : 'NOVA and its specialists cannot think until you add an NVIDIA NIM API key. Nothing is simulated without one.'}
              </AppText>
            </Panel>

            <View>
              <SectionHeader label="API key" />
              <Panel style={{ gap: spacing.md }}>
                <AppText variant="caption">
                  Create a free key at build.nvidia.com. It is stored in Android&apos;s encrypted
                  keystore and sent only to integrate.api.nvidia.com — never to this repo, the app
                  bundle or any other server.
                </AppText>

                {hasKey ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.sm,
                      padding: spacing.md,
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor: `${colors.success}44`,
                      backgroundColor: `${colors.success}12`,
                    }}
                  >
                    <Ionicons name="lock-closed" size={14} color={colors.success} />
                    <AppText variant="bodyStrong" style={{ flex: 1, fontSize: 13 }}>
                      Key stored securely
                    </AppText>
                    <AppText variant="micro" style={{ color: colors.success }}>
                      ACTIVE
                    </AppText>
                  </View>
                ) : null}

                <FormField
                  label={hasKey ? 'Replace key' : 'Paste key'}
                  placeholder="nvapi-…"
                  value={draft}
                  onChangeText={setDraft}
                  autoCapitalize="none"
                  autoCorrect={false}
                  secureTextEntry
                  maxLength={200}
                  hint="The field is masked. The stored key is never displayed again."
                />

                <NeonButton
                  label={hasKey ? 'Save replacement key' : 'Save key'}
                  icon="save-outline"
                  onPress={handleSave}
                  loading={saving}
                  disabled={!draft.trim()}
                />

                <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <View style={{ flex: 1 }}>
                    <NeonButton
                      label="Test"
                      icon="pulse-outline"
                      variant="ghost"
                      onPress={handleTest}
                      loading={testing}
                      disabled={!hasKey || runtime.isBusy('test')}
                    />
                  </View>
                  <View style={{ flex: 1 }}>
                    <NeonButton
                      label="Get a key"
                      icon="open-outline"
                      variant="ghost"
                      onPress={openKeyPage}
                    />
                  </View>
                </View>

                {hasKey ? (
                  <Pressable onPress={handleRemove} hitSlop={8}>
                    <AppText variant="micro" align="center" style={{ color: colors.danger }}>
                      REMOVE KEY FROM THIS DEVICE
                    </AppText>
                  </Pressable>
                ) : null}

                {status ? (
                  <View
                    style={{
                      flexDirection: 'row',
                      alignItems: 'flex-start',
                      gap: spacing.sm,
                      padding: spacing.md,
                      borderRadius: radius.md,
                      borderWidth: 1,
                      borderColor:
                        status.tone === 'ok' ? `${colors.success}44` : `${colors.danger}55`,
                      backgroundColor:
                        status.tone === 'ok' ? `${colors.success}10` : `${colors.danger}10`,
                    }}
                  >
                    <Ionicons
                      name={status.tone === 'ok' ? 'checkmark-circle' : 'alert-circle'}
                      size={15}
                      color={status.tone === 'ok' ? colors.success : colors.danger}
                      style={{ marginTop: 1 }}
                    />
                    <AppText variant="caption" style={{ flex: 1 }}>
                      {status.text}
                    </AppText>
                  </View>
                ) : null}

                {testing ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <ActivityIndicator size="small" color={colors.cyan} />
                    <AppText variant="micro">CONTACTING NVIDIA NIM…</AppText>
                  </View>
                ) : null}
              </Panel>
            </View>

            <View>
              <SectionHeader label="Model" />
              <Panel style={{ gap: spacing.md }}>
                <AppText variant="caption">
                  Every agent uses this model. All listed models support tool calling, which is how
                  NOVA delegates to specialists.
                </AppText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  {NIM_MODELS.map((option) => (
                    <Chip
                      key={option.id}
                      label={option.label}
                      color={colors.violet}
                      active={model === option.id}
                      onPress={() => setModel(option.id)}
                    />
                  ))}
                </View>
                <View style={{ gap: 2 }}>
                  {NIM_MODELS.filter((option) => option.id === model).map((option) => (
                    <React.Fragment key={option.id}>
                      <AppText variant="bodyStrong" style={{ fontSize: 13 }}>
                        {option.label}
                      </AppText>
                      <AppText variant="micro">{option.id}</AppText>
                      <AppText variant="micro" style={{ marginTop: 2, letterSpacing: 0.5 }}>
                        {option.note.toUpperCase()}
                      </AppText>
                    </React.Fragment>
                  ))}
                </View>
              </Panel>
            </View>

            <View>
              <SectionHeader label="Free tier limits" />
              <Panel style={{ gap: spacing.sm }}>
                <AppText variant="caption">
                  NVIDIA NIM&apos;s developer tier is free and rate limited to roughly 40 requests
                  per minute. A delegation uses several requests: NOVA plans, the specialist works,
                  then NOVA reports. If you hit the limit the app tells you and keeps your work.
                </AppText>
              </Panel>
            </View>
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}
