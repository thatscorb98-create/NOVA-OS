import React from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';

import { AppText } from '@/components/ui/AppText';
import { colors, fonts, radius, spacing } from '@/theme';

interface FormFieldProps extends TextInputProps {
  label: string;
  hint?: string;
}

export function FormField({ label, hint, multiline, style, ...rest }: FormFieldProps) {
  return (
    <View style={{ gap: spacing.sm }}>
      <AppText variant="label">{label.toUpperCase()}</AppText>
      <TextInput
        {...rest}
        multiline={multiline}
        placeholderTextColor={colors.textDim}
        style={[
          {
            color: colors.text,
            fontFamily: fonts.body,
            fontSize: 15,
            lineHeight: 21,
            paddingHorizontal: spacing.md + 2,
            paddingVertical: spacing.md,
            minHeight: multiline ? 96 : 48,
            textAlignVertical: multiline ? 'top' : 'center',
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: colors.panelBorder,
            backgroundColor: 'rgba(10, 14, 28, 0.9)',
          },
          style,
        ]}
      />
      {hint ? (
        <AppText variant="micro" style={{ letterSpacing: 0.4 }}>
          {hint}
        </AppText>
      ) : null}
    </View>
  );
}
