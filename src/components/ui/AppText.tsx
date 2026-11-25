import React from 'react';
import { Text, type TextProps, type TextStyle } from 'react-native';

import { textStyles, type TextVariant } from '@/theme';

interface AppTextProps extends TextProps {
  variant?: TextVariant;
  color?: string;
  align?: TextStyle['textAlign'];
}

/** Typography primitive: every string in NOVA OS renders through this. */
export function AppText({
  variant = 'body',
  color,
  align,
  style,
  children,
  ...rest
}: AppTextProps) {
  return (
    <Text
      {...rest}
      style={[textStyles[variant], color ? { color } : null, align ? { textAlign: align } : null, style]}
    >
      {children}
    </Text>
  );
}
