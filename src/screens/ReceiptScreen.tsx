import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Share, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { formatCurrency } from '../utils/currency';

type Params = {
  amount: number;
  currency: string;
  recipientName: string;
  recipientId?: string;
  timestamp: number;
  transactionId?: string;
};

export default function ReceiptScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const p = (route.params as Params) ?? {
    amount: 0,
    currency: 'XAF',
    recipientName: 'Recipient',
    timestamp: Date.now(),
  };

  const dateStr = new Date(p.timestamp).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  const shortRef = p.transactionId?.substring(0, 14) ?? 'TX' + Date.now().toString().slice(-8);

  const handleShare = async () => {
    try {
      await Share.share({
        message:
          `EGWallet Receipt\n─────────────\nTo: ${p.recipientName}\nAmount: ${formatCurrency(p.amount, p.currency)}\nDate: ${dateStr}\nStatus: Completed ✅\nRef: ${shortRef}\n\nSent via EGWallet`,
      });
    } catch {}
  };

  const rows = [
    { label: 'To', value: p.recipientName },
    ...(p.recipientId && p.recipientId !== p.recipientName
      ? [{ label: 'Wallet ID', value: p.recipientId.length > 14 ? p.recipientId.substring(0, 14) + '…' : p.recipientId }]
      : []),
    { label: 'Amount', value: formatCurrency(p.amount, p.currency), bold: true },
    { label: 'Date & Time', value: dateStr },
    { label: 'Reference', value: shortRef },
  ];

  return (
    <LinearGradient colors={['#DEEEFF', '#F5F9FF', '#FFFFFF']} style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Success animation */}
        <View style={styles.circleOuter}>
          <LinearGradient colors={['#1565C0', '#0A3D7C']} style={styles.circleInner}>
            <Ionicons name="checkmark" size={52} color="#fff" />
          </LinearGradient>
        </View>

        <Text style={styles.headline}>Payment Sent</Text>
        <Text style={styles.amount}>{formatCurrency(p.amount, p.currency)}</Text>
        <Text style={styles.subtitle}>Transaction Completed ✅</Text>

        {/* Receipt card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Ionicons name="receipt" size={18} color="#1565C0" />
            <Text style={styles.cardTitle}>RECEIPT</Text>
          </View>

          {rows.map(({ label, value, bold }, i) => (
            <View key={label} style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
              <Text style={styles.rowLabel}>{label}</Text>
              <Text
                style={[styles.rowValue, bold && { color: '#1565C0', fontSize: 15 }]}
                numberOfLines={1}
              >
                {value}
              </Text>
            </View>
          ))}

          <View style={styles.statusRow}>
            <Text style={styles.rowLabel}>Status</Text>
            <View style={styles.badge}>
              <Ionicons name="checkmark-circle" size={15} color="#15803D" />
              <Text style={styles.badgeText}>Completed</Text>
            </View>
          </View>

          {/* Dashed separator */}
          <View style={styles.dashes}>
            {Array.from({ length: 28 }).map((_, i) => (
              <View key={i} style={styles.dash} />
            ))}
          </View>

          <View style={styles.brand}>
            <Ionicons name="flash" size={16} color="#1565C0" />
            <Text style={styles.brandText}>EGWallet</Text>
          </View>
        </View>

        {/* Action buttons */}
        <TouchableOpacity style={styles.shareBtn} onPress={handleShare} activeOpacity={0.8}>
          <Ionicons name="share-social-outline" size={20} color="#1565C0" />
          <Text style={styles.shareBtnText}>Share Receipt</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.doneBtn}
          onPress={() => (navigation as any).navigate('Main')}
          activeOpacity={0.85}
        >
          <LinearGradient
            colors={['#1565C0', '#0A3D7C']}
            style={styles.doneBtnGradient}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
          >
            <Text style={styles.doneBtnText}>Done</Text>
          </LinearGradient>
        </TouchableOpacity>
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    alignItems: 'center',
    paddingTop: 52,
    paddingBottom: 48,
    paddingHorizontal: 24,
  },
  circleOuter: {
    width: 112,
    height: 112,
    borderRadius: 56,
    backgroundColor: 'rgba(21,101,192,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 22,
  },
  circleInner: {
    width: 90,
    height: 90,
    borderRadius: 45,
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.4,
    shadowRadius: 16,
    elevation: 10,
  },
  headline: { fontSize: 24, fontWeight: '800', color: '#0D1B2E', marginBottom: 6 },
  amount: {
    fontSize: 44,
    fontWeight: '800',
    color: '#1565C0',
    letterSpacing: -1.5,
    marginBottom: 4,
  },
  subtitle: { fontSize: 15, color: '#657786', marginBottom: 36 },
  card: {
    width: '100%',
    backgroundColor: '#fff',
    borderRadius: 22,
    padding: 22,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.1,
    shadowRadius: 20,
    elevation: 6,
    marginBottom: 24,
  },
  cardHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 18,
  },
  cardTitle: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.6,
    color: '#1565C0',
  },
  row: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F4F9',
  },
  rowLabel: { fontSize: 14, color: '#657786', fontWeight: '500' },
  rowValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#0D1B2E',
    maxWidth: '58%',
    textAlign: 'right',
  },
  statusRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingTop: 12,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
  },
  badgeText: { fontSize: 13, fontWeight: '700', color: '#15803D' },
  dashes: {
    flexDirection: 'row',
    marginTop: 20,
    marginBottom: 16,
    flexWrap: 'wrap',
  },
  dash: {
    width: 5,
    height: 2,
    backgroundColor: '#DDE4EF',
    marginHorizontal: 2,
    marginVertical: 1,
    borderRadius: 1,
  },
  brand: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
  },
  brandText: {
    fontSize: 15,
    fontWeight: '800',
    color: '#1565C0',
    letterSpacing: -0.2,
  },
  shareBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    width: '100%',
    paddingVertical: 15,
    borderRadius: 14,
    backgroundColor: '#EEF3FA',
    justifyContent: 'center',
    marginBottom: 12,
  },
  shareBtnText: { fontSize: 16, fontWeight: '700', color: '#1565C0' },
  doneBtn: { width: '100%', borderRadius: 14, overflow: 'hidden' },
  doneBtnGradient: { paddingVertical: 16, alignItems: 'center' },
  doneBtnText: {
    fontSize: 16,
    fontWeight: '800',
    color: '#fff',
    letterSpacing: 0.2,
  },
});
