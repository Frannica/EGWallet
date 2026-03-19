import React, { useRef, useEffect } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, ScrollView, Animated,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';

const ACTIONS = [
  {
    key: 'send',
    icon: 'send' as const,
    label: 'Send Money',
    subtitle: 'Transfer to any wallet or contact',
    gradientColors: ['#1565C0', '#0A3D7C'] as [string, string],
    iconBg: 'rgba(255,255,255,0.18)',
    route: 'Send',
  },
  {
    key: 'request',
    icon: 'download' as const,
    label: 'Request Money',
    subtitle: 'From contacts, employers or via QR',
    gradientColors: ['#0A7C55', '#0D5C40'] as [string, string],
    iconBg: 'rgba(255,255,255,0.18)',
    route: 'Request',
  },
  {
    key: 'qr',
    icon: 'qr-code' as const,
    label: 'QR Payment',
    subtitle: 'Scan or generate a QR code',
    gradientColors: ['#7B3FA0', '#5A2D7A'] as [string, string],
    iconBg: 'rgba(255,255,255,0.18)',
    route: 'QRPayment',
  },
];

export default function PayScreen() {
  const navigation = useNavigation<any>();
  const fadeAnim = useRef(new Animated.Value(0)).current;
  // Store all slide animations in a single ref — keeps them stable across renders
  // and avoids the Rules-of-Hooks violation of calling useRef inside .map().
  const slideAnims = useRef(ACTIONS.map(() => new Animated.Value(24))).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }).start();
    ACTIONS.forEach((_, i) => {
      Animated.timing(slideAnims[i], {
        toValue: 0,
        duration: 380,
        delay: 80 + i * 90,
        useNativeDriver: true,
      }).start();
    });
  }, []);

  return (
    <LinearGradient
      colors={['#C5DFF8', '#DEEEFF', '#EBF4FE', '#F5F9FF', '#FFFFFF']}
      style={styles.gradient}
    >
      <Animated.ScrollView
        style={{ flex: 1, opacity: fadeAnim }}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={styles.hero}>
          <LinearGradient
            colors={['#1565C0', '#0A3D7C']}
            style={styles.heroIcon}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
          >
            <Ionicons name="swap-horizontal" size={30} color="#fff" />
          </LinearGradient>
          <Text style={styles.heroTitle}>Pay & Receive</Text>
          <Text style={styles.heroSub}>Choose how you want to move money</Text>
        </View>

        {/* Action Cards */}
        {ACTIONS.map((action, i) => (
          <Animated.View
            key={action.key}
            style={{ transform: [{ translateY: slideAnims[i] }], opacity: fadeAnim }}
          >
            <TouchableOpacity
              style={styles.cardOuter}
              onPress={() => navigation.navigate(action.route as never)}
              activeOpacity={0.87}
            >
              <LinearGradient
                colors={action.gradientColors}
                style={styles.cardGradient}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 0.8 }}
              >
                {/* Decorative blob */}
                <View style={styles.blob} />

                <View style={[styles.iconWrap, { backgroundColor: action.iconBg }]}>
                  <Ionicons name={action.icon} size={26} color="#fff" />
                </View>
                <View style={styles.cardText}>
                  <Text style={styles.cardLabel}>{action.label}</Text>
                  <Text style={styles.cardSub}>{action.subtitle}</Text>
                </View>
                <Ionicons name="chevron-forward" size={22} color="rgba(255,255,255,0.6)" />
              </LinearGradient>
            </TouchableOpacity>
          </Animated.View>
        ))}

        {/* Info row */}
        <View style={styles.infoRow}>
          <Ionicons name="shield-checkmark-outline" size={16} color="#1565C0" />
          <Text style={styles.infoText}>All transactions are encrypted and secure</Text>
        </View>
      </Animated.ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  gradient: {
    flex: 1,
  },
  content: {
    padding: 20,
    paddingBottom: 48,
  },
  hero: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 28,
  },
  heroIcon: {
    width: 66,
    height: 66,
    borderRadius: 33,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 14,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.35,
    shadowRadius: 14,
    elevation: 10,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0A3D7C',
    letterSpacing: 0.2,
    marginBottom: 4,
  },
  heroSub: {
    fontSize: 14,
    color: '#5580A0',
    fontWeight: '500',
  },
  cardOuter: {
    borderRadius: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
    elevation: 8,
    overflow: 'hidden',
  },
  cardGradient: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 22,
    paddingHorizontal: 20,
    gap: 16,
    overflow: 'hidden',
  },
  blob: {
    position: 'absolute',
    right: -30,
    top: -30,
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: 'rgba(255,255,255,0.08)',
  },
  iconWrap: {
    width: 52,
    height: 52,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardText: {
    flex: 1,
  },
  cardLabel: {
    fontSize: 17,
    fontWeight: '800',
    color: '#fff',
    marginBottom: 3,
    letterSpacing: 0.1,
  },
  cardSub: {
    fontSize: 12,
    color: 'rgba(255,255,255,0.75)',
    fontWeight: '500',
    lineHeight: 17,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    marginTop: 8,
    opacity: 0.75,
  },
  infoText: {
    fontSize: 12,
    color: '#1565C0',
    fontWeight: '500',
  },
});
