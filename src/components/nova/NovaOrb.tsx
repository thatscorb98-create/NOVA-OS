import React, { useEffect, useRef } from 'react';
import { Animated, Easing, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';

import { colors } from '@/theme';

interface NovaOrbProps {
  size?: number;
  /** Dims the orb when the reasoning core is offline. */
  offline?: boolean;
}

/** Living core indicator: pulsing rings around a luminous plasma centre. */
export function NovaOrb({ size = 140, offline = true }: NovaOrbProps) {
  const rings = useRef([new Animated.Value(0), new Animated.Value(0), new Animated.Value(0)]).current;
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loops = rings.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 900),
          Animated.timing(value, {
            toValue: 1,
            duration: 3000,
            easing: Easing.out(Easing.quad),
            useNativeDriver: true,
          }),
          Animated.timing(value, { toValue: 0, duration: 0, useNativeDriver: true }),
        ]),
      ),
    );

    const pulseLoop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1700,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );

    loops.forEach((loop) => loop.start());
    pulseLoop.start();

    return () => {
      loops.forEach((loop) => loop.stop());
      pulseLoop.stop();
    };
  }, [pulse, rings]);

  const coreSize = size * 0.56;
  const plasmaSize = size * 0.2;

  return (
    <View
      style={{
        width: size,
        height: size,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {rings.map((value, index) => (
        <Animated.View
          key={index}
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: size * 0.8,
            height: size * 0.8,
            borderRadius: size * 0.4,
            borderWidth: 1,
            borderColor: index % 2 === 0 ? colors.violet : colors.cyan,
            opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
            transform: [
              {
                scale: value.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.2] }),
              },
            ],
          }}
        />
      ))}

      <View
        style={{
          position: 'absolute',
          width: size * 0.86,
          height: size * 0.86,
          borderRadius: size * 0.43,
          borderWidth: 1,
          borderColor: 'rgba(139, 92, 246, 0.16)',
        }}
      />

      <Animated.View
        style={{
          transform: [
            { scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.05] }) },
          ],
          shadowColor: offline ? colors.violetDeep : colors.cyan,
          shadowOpacity: offline ? 0.5 : 0.9,
          shadowRadius: size * 0.28,
          shadowOffset: { width: 0, height: 0 },
        }}
      >
        <LinearGradient
          colors={offline ? ['#1E1440', '#0A0D1C'] : ['#2B1A63', '#0B1024']}
          start={{ x: 0.2, y: 0 }}
          end={{ x: 0.8, y: 1 }}
          style={{
            width: coreSize,
            height: coreSize,
            borderRadius: coreSize / 2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: offline ? 'rgba(139, 92, 246, 0.5)' : 'rgba(103, 232, 249, 0.6)',
          }}
        >
          <LinearGradient
            colors={[colors.cyanBright, colors.violet]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={{
              width: plasmaSize,
              height: plasmaSize,
              borderRadius: plasmaSize / 2,
              opacity: offline ? 0.55 : 1,
            }}
          />
        </LinearGradient>
      </Animated.View>
    </View>
  );
}
