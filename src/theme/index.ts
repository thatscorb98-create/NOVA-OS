import type { TextStyle } from 'react-native';

/**
 * NOVA OS design tokens.
 * Single source of truth for colour, spacing, radii and typography so the
 * interface stays consistent as new modules are added.
 */

export const colors = {
  bg: '#04050A',
  bgElevated: '#070912',
  panel: '#0A0E1C',
  panelRaised: '#0E1428',
  panelBorder: 'rgba(139, 92, 246, 0.20)',
  hairline: 'rgba(148, 163, 255, 0.10)',
  violet: '#8B5CF6',
  violetBright: '#A78BFA',
  violetDeep: '#5B21B6',
  cyan: '#22D3EE',
  cyanBright: '#67E8F9',
  pink: '#F472B6',
  amber: '#FBBF24',
  orange: '#FB923C',
  blue: '#60A5FA',
  emerald: '#34D399',
  red: '#F87171',
  text: '#F2F4FF',
  textMuted: '#98A0C4',
  textDim: '#5F6788',
  success: '#34D399',
  warning: '#FBBF24',
  danger: '#F87171',
  white: '#FFFFFF',
} as const;

export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 28,
  xxxl: 40,
} as const;

export const radius = {
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  pill: 999,
} as const;

export const fonts = {
  display: 'SpaceGrotesk_700Bold',
  heading: 'SpaceGrotesk_600SemiBold',
  label: 'SpaceGrotesk_500Medium',
  regular: 'SpaceGrotesk_400Regular',
  body: 'Inter_400Regular',
  bodyMedium: 'Inter_500Medium',
  bodySemi: 'Inter_600SemiBold',
} as const;

export type TextVariant =
  | 'display'
  | 'title'
  | 'heading'
  | 'subtitle'
  | 'body'
  | 'bodyStrong'
  | 'caption'
  | 'label'
  | 'micro';

export const textStyles: Record<TextVariant, TextStyle> = {
  display: {
    fontFamily: fonts.display,
    fontSize: 34,
    lineHeight: 40,
    letterSpacing: -1,
    color: colors.text,
  },
  title: {
    fontFamily: fonts.display,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.6,
    color: colors.text,
  },
  heading: {
    fontFamily: fonts.heading,
    fontSize: 17,
    lineHeight: 23,
    letterSpacing: -0.2,
    color: colors.text,
  },
  subtitle: {
    fontFamily: fonts.body,
    fontSize: 14.5,
    lineHeight: 21,
    color: colors.textMuted,
  },
  body: {
    fontFamily: fonts.body,
    fontSize: 14,
    lineHeight: 21,
    color: colors.text,
  },
  bodyStrong: {
    fontFamily: fonts.bodyMedium,
    fontSize: 14,
    lineHeight: 21,
    color: colors.text,
  },
  caption: {
    fontFamily: fonts.body,
    fontSize: 12.5,
    lineHeight: 18,
    color: colors.textMuted,
  },
  label: {
    fontFamily: fonts.heading,
    fontSize: 11,
    lineHeight: 15,
    letterSpacing: 1.8,
    color: colors.textMuted,
  },
  micro: {
    fontFamily: fonts.label,
    fontSize: 10,
    lineHeight: 14,
    letterSpacing: 1.1,
    color: colors.textDim,
  },
};

export const glow = (color: string, radius = 18, opacity = 0.35) =>
  ({
    shadowColor: color,
    shadowOpacity: opacity,
    shadowRadius: radius,
    shadowOffset: { width: 0, height: radius / 2 },
    elevation: 0,
  }) as const;
