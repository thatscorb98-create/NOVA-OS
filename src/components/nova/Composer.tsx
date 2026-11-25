import React from 'react';
import { Pressable, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { LinearGradient } from 'expo-linear-gradient';

import { colors, fonts, radius, spacing } from '@/theme';

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  placeholder?: string;
}

const MAX_LENGTH = 2000;

export function Composer({
  value,
  onChangeText,
  onSend,
  placeholder = 'Command NOVA…',
}: ComposerProps) {
  const canSend = value.trim().length > 0;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-end',
        gap: spacing.sm,
        paddingHorizontal: spacing.lg,
        paddingTop: spacing.sm,
        paddingBottom: spacing.md,
        borderTopWidth: 1,
        borderTopColor: colors.hairline,
        backgroundColor: 'rgba(5, 6, 12, 0.96)',
      }}
    >
      <View
        style={{
          flex: 1,
          flexDirection: 'row',
          alignItems: 'flex-end',
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
          borderRadius: radius.lg,
          borderWidth: 1,
          borderColor: colors.panelBorder,
          backgroundColor: 'rgba(10, 14, 28, 0.9)',
        }}
      >
        <TextInput
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor={colors.textDim}
          multiline
          maxLength={MAX_LENGTH}
          style={{
            flex: 1,
            color: colors.text,
            fontFamily: fonts.body,
            fontSize: 14.5,
            lineHeight: 20,
            maxHeight: 120,
            paddingTop: 6,
            paddingBottom: 6,
          }}
          onSubmitEditing={onSend}
          returnKeyType="send"
          blurOnSubmit={false}
          accessibilityLabel="Message NOVA"
        />
      </View>

      <Pressable
        onPress={onSend}
        disabled={!canSend}
        accessibilityRole="button"
        accessibilityLabel="Send message"
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          borderRadius: radius.pill,
          overflow: 'hidden',
          opacity: canSend ? (pressed ? 0.8 : 1) : 0.35,
        })}
      >
        <LinearGradient
          colors={[colors.violet, colors.violetDeep]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons name="arrow-up" size={19} color={colors.white} />
        </LinearGradient>
      </Pressable>
    </View>
  );
}
