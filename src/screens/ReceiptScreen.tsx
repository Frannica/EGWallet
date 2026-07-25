import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Share, ScrollView } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useRoute } from '@react-navigation/native';
import { formatCurrency } from '../utils/currency';
import { useLanguage } from '../i18n/LanguageContext';

type TxType = 'send' | 'receive' | 'deposit' | 'withdrawal' | 'exchange';
type TxStatus = 'completed' | 'pending' | 'failed';

type Params = {
  amount: number;
  currency: string;
  senderCurrency?: string;
  receiverCurrency?: string;
  recipientName: string;
  recipientId?: string;
  timestamp: number;
  // Durable, server-issued transaction ID. NEVER fabricate a placeholder
  // when this is missing — the receipt must show "Reference unavailable"
  // instead (see shortRef below).
  transactionId?: string;
  // Stripe PaymentIntent ID for deposits — safe to display (not a secret),
  // useful for the user to cross-reference their bank/card statement.
  paymentReference?: string;
  fee?: number;         // in minor units
  feeLabel?: string;   // e.g. "FX Conversion Fee (1.15%)"
  fxRate?: string;     // e.g. "1 USD = 655 XAF"
  type?: TxType;
  status?: TxStatus;
};

export default function ReceiptScreen() {
  const navigation = useNavigation();
  const route = useRoute();
  const { t } = useLanguage();
  const p = (route.params as Params) ?? {
    amount: 0, currency: 'XAF', recipientName: t('common.recipient'), timestamp: Date.now(),
  };

  const txType = p.type ?? 'send';
  const txStatus = p.status ?? 'completed';
  const TYPE_META_T: Record<TxType, { headline: string; subtitle: string; icon: string; iconColors: [string, string] }> = {
    send:       { headline: t('receipt.paymentSent'),        subtitle: t('receipt.transferSuccess'), icon: 'arrow-up-circle',   iconColors: ['#1565C0', '#0A3D7C'] },
    receive:    { headline: t('receipt.moneyReceived'),      subtitle: t('receipt.fundsAdded'),      icon: 'arrow-down-circle', iconColors: ['#15803D', '#166534'] },
    deposit:    { headline: t('receipt.depositSuccess'),     subtitle: t('receipt.fundsAdded'),      icon: 'add-circle',        iconColors: ['#A16207', '#854D0E'] },
    withdrawal: { headline: t('receipt.withdrawalSubmitted'), subtitle: t('receipt.beingProcessed'), icon: 'log-out',           iconColors: ['#F57C00', '#E65100'] },
    exchange:   { headline: t('receipt.exchangeCompleted'),  subtitle: t('receipt.exchangeSuccess'), icon: 'swap-horizontal',   iconColors: ['#7B3FA0', '#5A2D7A'] },
  };
  const STATUS_COLORS_T: Record<TxStatus, { bg: string; text: string; icon: string; label: string }> = {
    completed: { bg: '#DCFCE7', text: '#15803D', icon: 'checkmark-circle', label: t('receipt.completed') },
    pending:   { bg: '#FEF9C3', text: '#A16207', icon: 'time',             label: t('receipt.pending') },
    failed:    { bg: '#FEE2E2', text: '#DC2626', icon: 'close-circle',     label: t('receipt.failed') },
  };
  const meta = TYPE_META_T[txType];
  const statusStyle = STATUS_COLORS_T[txStatus];

  const isCrossCurrency = p.receiverCurrency && p.receiverCurrency !== p.currency;
  const hasFee = typeof p.fee === 'number' && p.fee > 0;

  const dateStr = new Date(p.timestamp).toLocaleString('en-US', {
    month: 'long', day: 'numeric', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
  // Durable server-issued reference only — never fabricate a placeholder ID.
  // If no verified transaction ID was passed in, tell the user plainly
  // rather than showing invented data.
  const hasRealRef = typeof p.transactionId === 'string' && p.transactionId.length > 0;
  const shortRef = hasRealRef ? p.transactionId!.substring(0, 16) : t('receipt.referenceUnavailable');

  // Build the share text
  const shareAmountLine =
    txType === 'deposit' ? t('receipt.shareDeposited').replace('{amount}', formatCurrency(p.amount, p.currency)) :
    txType === 'withdrawal' ? t('receipt.shareWithdrawn').replace('{amount}', formatCurrency(p.amount, p.currency)) :
    txType === 'receive' ? t('receipt.shareReceived').replace('{amount}', formatCurrency(p.amount, p.currency)) :
    t('receipt.shareSent').replace('{amount}', formatCurrency(p.amount, p.currency));
  const shareStatusLabel = STATUS_COLORS_T[txStatus].label;
  const shareLines = [
    t('receipt.shareHeader'),
    '─────────────────',
    shareAmountLine,
    ...(p.recipientName ? [(txType === 'receive' ? t('receipt.shareFrom') : t('receipt.shareTo')).replace('{name}', p.recipientName)] : []),
    ...(isCrossCurrency && p.receiverCurrency ? [t('receipt.shareReceivedCurrency').replace('{currency}', p.receiverCurrency)] : []),
    ...(hasFee && p.fee && p.currency ? [t('receipt.shareFee').replace('{amount}', `${formatCurrency(p.fee, p.currency)}${p.feeLabel ? ` (${p.feeLabel})` : ''}`)] : []),
    ...(p.fxRate ? [t('receipt.shareFxRate').replace('{rate}', p.fxRate)] : []),
    t('receipt.shareDate').replace('{date}', dateStr),
    t('receipt.shareStatus').replace('{status}', shareStatusLabel),
    t('receipt.shareRef').replace('{ref}', shortRef),
    '',
    t('receipt.shareFooter'),
  ];

  const handleShare = async () => {
    try { await Share.share({ message: shareLines.join('\n') }); } catch {}
  };

  // Build receipt rows dynamically
  const rows: Array<{ label: string; value: string; bold?: boolean; accent?: boolean }> = [];

  // Party line
  if (txType === 'receive') {
    rows.push({ label: t('common.from'), value: p.recipientName });
  } else if (txType === 'deposit') {
    rows.push({ label: t('receipt.addedTo'), value: p.recipientName || t('receipt.yourWallet') });
  } else if (txType === 'exchange') {
    rows.push({
      label: t('receipt.converted'),
      value: p.senderCurrency && p.receiverCurrency ? `${p.senderCurrency} → ${p.receiverCurrency}` : (p.recipientName || ''),
    });
  } else {
    rows.push({ label: t('common.to'), value: p.recipientName });
    if (p.recipientId && p.recipientId !== p.recipientName) {
      rows.push({ label: t('receipt.walletId'), value: p.recipientId.length > 16 ? p.recipientId.substring(0, 16) + '…' : p.recipientId });
    }
  }

  // Amount + currencies
  rows.push({ label: t('common.amount'), value: formatCurrency(p.amount, p.currency), bold: true });
  if (txType !== 'exchange') {
    if (p.senderCurrency) rows.push({ label: t('receipt.senderCurrency'), value: p.senderCurrency });
    if (isCrossCurrency && p.receiverCurrency) {
      rows.push({ label: t('receipt.recipientCurrency'), value: p.receiverCurrency, accent: true });
    }
  }

  // Fee
  if (hasFee && p.fee && p.currency) {
    rows.push({ label: p.feeLabel ?? t('receipt.transferFee'), value: formatCurrency(p.fee, p.currency) });
  } else if (txType === 'send' || txType === 'receive') {
    rows.push({ label: t('receipt.transferFee'), value: t('common.free') });
  }

  // FX rate
  if (p.fxRate) rows.push({ label: t('receipt.fxRate'), value: p.fxRate, accent: true });

  // Date & ref
  rows.push({ label: t('receipt.dateTime'), value: dateStr });
  rows.push({ label: t('receipt.reference'), value: shortRef });
  // Deposit receipts safely surface the Stripe PaymentIntent reference too —
  // it is not sensitive (no card data), and lets the user cross-reference
  // their bank/card statement. Only shown when a real one was provided.
  if (txType === 'deposit' && p.paymentReference) {
    rows.push({
      label: t('receipt.paymentReference'),
      value: p.paymentReference.length > 24 ? p.paymentReference.substring(0, 24) + '…' : p.paymentReference,
    });
  }

  return (
    <LinearGradient colors={['#DEEEFF', '#F5F9FF', '#FFFFFF']} style={styles.container}>
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        {/* Icon */}
        <View style={styles.circleOuter}>
          <LinearGradient colors={meta.iconColors} style={styles.circleInner}>
            <Ionicons name={meta.icon as any} size={46} color="#fff" />
          </LinearGradient>
        </View>

        <Text style={styles.headline}>{meta.headline}</Text>
        <Text style={styles.amount}>{formatCurrency(p.amount, p.currency)}</Text>
        <Text style={styles.subtitle}>{meta.subtitle}</Text>

        {/* Receipt card */}
        <View style={styles.card}>
          <View style={styles.cardHeaderRow}>
            <Ionicons name="receipt" size={18} color="#1565C0" />
            <Text style={styles.cardTitle}>{t('receipt.receipt')}</Text>
          </View>

          {rows.map(({ label, value, bold, accent }, i) => (
            <View key={label} style={[styles.row, i === rows.length - 1 && { borderBottomWidth: 0 }]}>
              <Text style={styles.rowLabel}>{label}</Text>
              <Text
                style={[
                  styles.rowValue,
                  bold && { color: '#1565C0', fontSize: 15 },
                  accent && { color: '#7C3AED' },
                ]}
                numberOfLines={1}
              >
                {value}
              </Text>
            </View>
          ))}

          <View style={styles.statusRow}>
            <Text style={styles.rowLabel}>{t('receipt.status')}</Text>
            <View style={[styles.badge, { backgroundColor: statusStyle.bg }]}>
              <Ionicons name={statusStyle.icon as any} size={15} color={statusStyle.text} />
              <Text style={[styles.badgeText, { color: statusStyle.text }]}>
                {statusStyle.label}
              </Text>
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
          <Text style={styles.shareBtnText}>{t('receipt.shareReceipt')}</Text>
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
            <Text style={styles.doneBtnText}>{t('receipt.done')}</Text>
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

