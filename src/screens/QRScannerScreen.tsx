import React, { useState, useEffect, useRef } from 'react';
import {
  View, Text, StyleSheet, TouchableOpacity, Alert, Modal,
  ActivityIndicator, TextInput, KeyboardAvoidingView, Platform, ScrollView,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { sendTransaction } from '../api/transactions';
import { listWallets } from '../api/auth';
import { majorToMinor, formatCurrency } from '../utils/currency';
import { useLanguage } from '../i18n/LanguageContext';

// ─── QR payload types ────────────────────────────────────────────────────────

interface WalletAddressPayload {
  type: 'wallet_address';
  walletId: string;
  version?: number;
}

interface PaymentRequestPayload {
  type: 'payment_request';
  walletId: string;
  amount: number;        // minor units
  currency: string;
  memo?: string;
  requestId?: string;
  expiresAt?: number;
}

type QRPayload = WalletAddressPayload | PaymentRequestPayload;

function formatAmountInput(text: string): string {
  const cleaned = text.replace(/[^0-9.]/g, '');
  const parts = cleaned.split('.');
  const intPart = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return parts.length > 1 ? intPart + '.' + parts[1] : intPart;
}

// ─── Screen ──────────────────────────────────────────────────────────────────

export default function QRScannerScreen() {
  const navigation = useNavigation<any>();
  const auth = useAuth();
  const { t } = useLanguage();

  const [permission, requestPermission] = useCameraPermissions();
  const [flashOn, setFlashOn] = useState(false);
  const [scanned, setScanned] = useState(false);

  // Confirmation modal
  const [showConfirm, setShowConfirm] = useState(false);
  const [qrPayload, setQrPayload] = useState<QRPayload | null>(null);

  // For wallet_address type: user types the amount
  const [manualAmount, setManualAmount] = useState('');
  const [manualCurrency, setManualCurrency] = useState('');

  // Payment state
  const [paying, setPaying] = useState(false);
  const [myWalletId, setMyWalletId] = useState<string | null>(null);

  // Load sender wallet on mount
  useEffect(() => {
    if (!auth.token) return;
    listWallets(auth.token)
      .then((data: any) => {
        const id = data?.wallets?.[0]?.id ?? null;
        setMyWalletId(id);
      })
      .catch(() => {/* non-critical — will surface at pay time */});
  }, [auth.token]);

  // ── Barcode handler ─────────────────────────────────────────────────────

  const handleBarcodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    setScanned(true);

    let payload: QRPayload;
    try {
      payload = JSON.parse(data);
    } catch {
      Alert.alert(
        t('qrScan.invalidQrTitle'),
        t('qrScan.invalidQrMessage'),
        [{ text: 'Scan Again', onPress: () => setScanned(false) }],
      );
      return;
    }

    if (payload.type !== 'wallet_address' && payload.type !== 'payment_request') {
      Alert.alert(
        t('qrScan.unsupportedQrTitle'),
        t('qrScan.unsupportedQrMessage'),
        [{ text: 'Scan Again', onPress: () => setScanned(false) }],
      );
      return;
    }

    // Check expiry for payment_request
    if (payload.type === 'payment_request' && payload.expiresAt) {
      if (Date.now() > payload.expiresAt) {
        Alert.alert(
          t('qrScan.qrExpiredTitle'),
          t('qrScan.qrExpiredMessage'),
          [{ text: 'Scan Again', onPress: () => setScanned(false) }],
        );
        return;
      }
    }

    // Pre-fill currency for wallet_address type from user's preferred currency
    if (payload.type === 'wallet_address') {
      setManualAmount('');
      setManualCurrency(auth.user?.preferredCurrency ?? 'XAF');
    }

    setQrPayload(payload);
    setShowConfirm(true);
  };

  // ── Pay handler ─────────────────────────────────────────────────────────

  const handlePay = async () => {
    if (!auth.token) return;
    if (!myWalletId) {
      Alert.alert(t('common.error'), t('qrScan.walletLoadError'));
      return;
    }
    if (!qrPayload) return;

    let toWalletId: string;
    let amountMinor: number;
    let currency: string;
    let memo: string | undefined;

    if (qrPayload.type === 'payment_request') {
      // Validate embedded values before trusting them
      if (!qrPayload.walletId || typeof qrPayload.walletId !== 'string' || !qrPayload.walletId.trim()) {
        Alert.alert(t('common.invalidQr'), t('qrScan.missingWalletId'));
        return;
      }
      if (typeof qrPayload.amount !== 'number' || !isFinite(qrPayload.amount) || qrPayload.amount <= 0) {
        Alert.alert(t('common.invalidQr'), t('qrScan.invalidQrAmount'));
        return;
      }
      if (!qrPayload.currency || typeof qrPayload.currency !== 'string' || !qrPayload.currency.trim()) {
        Alert.alert(t('common.invalidQr'), t('qrScan.missingQrCurrency'));
        return;
      }
      toWalletId = qrPayload.walletId.trim();
      amountMinor = qrPayload.amount;
      currency = qrPayload.currency.trim().toUpperCase();
      memo = qrPayload.memo;
    } else {
      // wallet_address — user entered amount
      const raw = parseFloat(manualAmount.replace(/,/g, ''));
      if (!manualAmount || isNaN(raw) || raw <= 0) {
        Alert.alert(t('common.invalidAmount'), t('qrScan.invalidAmount'));
        return;
      }
      if (!manualCurrency.trim()) {
        Alert.alert(t('common.missingCurrency'), t('qrScan.missingCurrency'));
        return;
      }
      toWalletId = qrPayload.walletId;
      amountMinor = majorToMinor(raw, manualCurrency.toUpperCase());
      currency = manualCurrency.toUpperCase();
      memo = 'QR Payment';
    }

    if (toWalletId === myWalletId) {
      Alert.alert(t('common.error'), t('qrScan.cantPayYourself'));
      return;
    }

    setPaying(true);
    try {
      const result = await sendTransaction(
        auth.token,
        myWalletId,
        toWalletId,
        amountMinor,
        currency,
        memo,
      );

      const tx = result?.transaction ?? result;
      setShowConfirm(false);
      setPaying(false);

      const sentDisplay = formatCurrency(amountMinor, currency);
      const receivedDisplay = tx?.receivedAmount != null
        ? formatCurrency(tx.receivedAmount, tx.receivedCurrency ?? currency)
        : null;

      Alert.alert(
        t('qrScan.paymentSentTitle'),
        receivedDisplay && tx?.wasConverted
          ? `You sent ${sentDisplay}\nRecipient received ${receivedDisplay}`
          : t('qrScan.paymentSentMsg'),
        [
          {
            text: 'Done',
            onPress: () => {
              setScanned(false);
              navigation.goBack();
            },
          },
        ],
      );
    } catch (err: any) {
      setPaying(false);
      Alert.alert(t('common.error'), err.message ?? t('qrScan.somethingWentWrong'));
    }
  };

  const handleCloseConfirm = () => {
    setShowConfirm(false);
    setQrPayload(null);
    setScanned(false);
    setPaying(false);
  };

  // ── Permission not yet requested ─────────────────────────────────────────

  if (!permission) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1565C0" />
      </View>
    );
  }

  // ── Permission denied ────────────────────────────────────────────────────

  if (!permission.granted) {
    return (
      <View style={styles.permissionScreen}>
        <Ionicons name="camera-outline" size={64} color="#1565C0" />
        <Text style={styles.permissionTitle}>{t('qrScan.cameraNeeded')}</Text>
        <Text style={styles.permissionDesc}>
          {t('qrScan.cameraDesc')}
        </Text>
        <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
          <Text style={styles.permissionBtnText}>{t('qrScan.grantCamera')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.backLink} onPress={() => navigation.goBack()}>
          <Text style={styles.backLinkText}>{t('qrScan.goBack')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ── Expiry label helper ───────────────────────────────────────────────────

  const getExpiryLabel = (expiresAt?: number) => {
    if (!expiresAt) return null;
    const remaining = Math.floor((expiresAt - Date.now()) / 1000 / 60);
    if (remaining <= 0) return t('qrScan.expired');
    if (remaining < 5) return `⚠️ Expires in ${remaining} min`;
    return `Valid for ~${remaining} min`;
  };

  // ── Main camera UI ────────────────────────────────────────────────────────

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFillObject}
        facing="back"
        flash={flashOn ? 'on' : 'off'}
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanned ? undefined : handleBarcodeScanned}
      />

      {/* Dark overlay with transparent hole */}
      <View style={styles.overlay} pointerEvents="none">
        <View style={styles.overlayTop} />
        <View style={styles.overlayMiddleRow}>
          <View style={styles.overlaySide} />
          <View style={styles.scanWindow}>
            {/* Corner markers */}
            <View style={[styles.corner, styles.cornerTL]} />
            <View style={[styles.corner, styles.cornerTR]} />
            <View style={[styles.corner, styles.cornerBL]} />
            <View style={[styles.corner, styles.cornerBR]} />
          </View>
          <View style={styles.overlaySide} />
        </View>
        <View style={styles.overlayBottom} />
      </View>

      {/* Top bar */}
      <View style={styles.topBar}>
        <TouchableOpacity style={styles.iconBtn} onPress={() => navigation.goBack()}>
          <Ionicons name="arrow-back" size={24} color="#fff" />
        </TouchableOpacity>
        <Text style={styles.topTitle}>{t('qrScan.title')}</Text>
        <TouchableOpacity style={styles.iconBtn} onPress={() => setFlashOn(f => !f)}>
          <Ionicons name={flashOn ? 'flash' : 'flash-off'} size={24} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* Instruction text */}
      <View style={styles.instructionRow}>
        <Text style={styles.instructionText}>
          {t('qrScan.subtitle')}
        </Text>
      </View>

      {/* Scan again button (shown after a failed scan) */}
      {scanned && !showConfirm && (
        <View style={styles.scanAgainRow}>
          <TouchableOpacity style={styles.scanAgainBtn} onPress={() => setScanned(false)}>
            <Text style={styles.scanAgainText}>{t('qrScan.scanAgain')}</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ── Confirmation modal ──────────────────────────────────────────── */}
      <Modal
        visible={showConfirm}
        animationType="slide"
        transparent
        onRequestClose={handleCloseConfirm}
      >
        <KeyboardAvoidingView
          style={styles.modalBackdrop}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          <View style={styles.sheet}>
            <View style={styles.sheetHandle} />

            <ScrollView showsVerticalScrollIndicator={false}>
              {/* Header */}
              <View style={styles.sheetHeader}>
                <View style={styles.sheetIconCircle}>
                  <Ionicons name="qr-code" size={26} color="#1565C0" />
                </View>
                <Text style={styles.sheetTitle}>
                  {qrPayload?.type === 'payment_request' ? 'Confirm Payment' : t('qrScan.payViaQr')}
                </Text>
              </View>

              {qrPayload?.type === 'payment_request' && (
                <>
                  {/* Amount row */}
                  <View style={styles.amountCard}>
                    <Text style={styles.amountCardLabel}>{t('qrScan.amountToPay')}</Text>
                    <Text style={styles.amountCardValue}>
                      {formatCurrency(qrPayload.amount, qrPayload.currency)}
                    </Text>
                    <Text style={styles.amountCardCurrency}>{qrPayload.currency}</Text>
                  </View>

                  {qrPayload.memo ? (
                    <View style={styles.detailRow}>
                      <Ionicons name="receipt-outline" size={16} color="#666" />
                      <Text style={styles.detailLabel}>{t('qrScan.for')}</Text>
                      <Text style={styles.detailValue}>{qrPayload.memo}</Text>
                    </View>
                  ) : null}

                  <View style={styles.detailRow}>
                    <Ionicons name="wallet-outline" size={16} color="#666" />
                    <Text style={styles.detailLabel}>{t('qrScan.toWallet')}</Text>
                    <Text style={styles.detailValue} numberOfLines={1}>
                      {qrPayload.walletId.length > 20
                        ? `${qrPayload.walletId.slice(0, 10)}...${qrPayload.walletId.slice(-6)}`
                        : qrPayload.walletId}
                    </Text>
                  </View>

                  {qrPayload.expiresAt ? (
                    <View style={styles.detailRow}>
                      <Ionicons name="time-outline" size={16} color="#666" />
                      <Text style={styles.detailLabel}>{t('qrScan.valid')}</Text>
                      <Text style={[
                        styles.detailValue,
                        (Date.now() > (qrPayload.expiresAt - 5 * 60 * 1000)) && { color: '#D32F2F' },
                      ]}>
                        {getExpiryLabel(qrPayload.expiresAt)}
                      </Text>
                    </View>
                  ) : null}

                  <Text style={styles.feeNote}>
                    {qrPayload.currency === (auth.user?.preferredCurrency ?? qrPayload.currency)
                      ? t('qrScan.noConversionFee')
                      : t('qrScan.fxFee')}
                  </Text>
                </>
              )}

              {qrPayload?.type === 'wallet_address' && (
                <>
                  <View style={styles.detailRow}>
                    <Ionicons name="wallet-outline" size={16} color="#666" />
                    <Text style={styles.detailLabel}>{t('qrScan.toWallet')}</Text>
                    <Text style={styles.detailValue} numberOfLines={1}>
                      {qrPayload.walletId.length > 20
                        ? `${qrPayload.walletId.slice(0, 10)}...${qrPayload.walletId.slice(-6)}`
                        : qrPayload.walletId}
                    </Text>
                  </View>

                  <Text style={styles.inputLabel}>{t('qrScan.amount')}</Text>
                  <TextInput
                    style={styles.input}
                    value={manualAmount}
                    onChangeText={v => setManualAmount(formatAmountInput(v))}
                    placeholder="0.00"
                    keyboardType="numeric"
                    placeholderTextColor="#aaa"
                    editable={!paying}
                  />

                  <Text style={styles.inputLabel}>{t('qrScan.currency')}</Text>
                  <TextInput
                    style={styles.input}
                    value={manualCurrency}
                    onChangeText={t => setManualCurrency(t.toUpperCase())}
                    placeholder="XAF"
                    autoCapitalize="characters"
                    maxLength={5}
                    placeholderTextColor="#aaa"
                    editable={!paying}
                  />
                </>
              )}

              {/* Pay button */}
              <TouchableOpacity
                style={[styles.payBtn, paying && styles.payBtnDisabled]}
                onPress={handlePay}
                disabled={paying}
              >
                {paying
                  ? <ActivityIndicator color="#fff" />
                  : (
                    <View style={styles.payBtnInner}>
                      <Ionicons name="checkmark-circle" size={20} color="#fff" />
                      <Text style={styles.payBtnText}>{t('qrScan.payNow')}</Text>
                    </View>
                  )
                }
              </TouchableOpacity>

              <TouchableOpacity style={styles.cancelBtn} onPress={handleCloseConfirm} disabled={paying}>
                <Text style={styles.cancelBtnText}>{t('qrScan.cancel')}</Text>
              </TouchableOpacity>
            </ScrollView>
          </View>
        </KeyboardAvoidingView>
      </Modal>
    </View>
  );
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const WINDOW_SIZE = 240;
const CORNER_SIZE = 24;
const CORNER_THICKNESS = 4;
const CORNER_RADIUS = 4;

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },

  centered: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' },

  // ── Overlay ──────────────────────────────────────────────────────────────
  overlay: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: 'column',
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  overlayMiddleRow: {
    flexDirection: 'row',
    height: WINDOW_SIZE,
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  overlayBottom: {
    flex: 1.4,
    backgroundColor: 'rgba(0,0,0,0.62)',
  },
  scanWindow: {
    width: WINDOW_SIZE,
    height: WINDOW_SIZE,
    backgroundColor: 'transparent',
  },
  corner: {
    position: 'absolute',
    width: CORNER_SIZE,
    height: CORNER_SIZE,
  },
  cornerTL: {
    top: 0, left: 0,
    borderTopWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS,
    borderColor: '#fff', borderTopLeftRadius: CORNER_RADIUS,
  },
  cornerTR: {
    top: 0, right: 0,
    borderTopWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS,
    borderColor: '#fff', borderTopRightRadius: CORNER_RADIUS,
  },
  cornerBL: {
    bottom: 0, left: 0,
    borderBottomWidth: CORNER_THICKNESS, borderLeftWidth: CORNER_THICKNESS,
    borderColor: '#fff', borderBottomLeftRadius: CORNER_RADIUS,
  },
  cornerBR: {
    bottom: 0, right: 0,
    borderBottomWidth: CORNER_THICKNESS, borderRightWidth: CORNER_THICKNESS,
    borderColor: '#fff', borderBottomRightRadius: CORNER_RADIUS,
  },

  // ── Top bar ───────────────────────────────────────────────────────────────
  topBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: 48, paddingHorizontal: 16, paddingBottom: 12,
  },
  iconBtn: {
    width: 40, height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center', alignItems: 'center',
  },
  topTitle: {
    color: '#fff', fontSize: 18, fontWeight: '700',
  },

  // ── Instruction ───────────────────────────────────────────────────────────
  instructionRow: {
    position: 'absolute',
    bottom: '32%',
    left: 0, right: 0,
    alignItems: 'center',
  },
  instructionText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 14,
    textAlign: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
    paddingHorizontal: 16, paddingVertical: 6,
    borderRadius: 20,
  },

  // ── Scan again ────────────────────────────────────────────────────────────
  scanAgainRow: {
    position: 'absolute', bottom: 60, left: 0, right: 0, alignItems: 'center',
  },
  scanAgainBtn: {
    backgroundColor: '#1565C0',
    paddingHorizontal: 28, paddingVertical: 12,
    borderRadius: 24,
  },
  scanAgainText: { color: '#fff', fontWeight: '700', fontSize: 15 },

  // ── Permission screen ─────────────────────────────────────────────────────
  permissionScreen: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: '#F5F9FF', padding: 32,
  },
  permissionTitle: {
    fontSize: 22, fontWeight: '800', color: '#0D1B2E',
    marginTop: 20, marginBottom: 10,
  },
  permissionDesc: {
    fontSize: 15, color: '#555', textAlign: 'center',
    lineHeight: 22, marginBottom: 28,
  },
  permissionBtn: {
    backgroundColor: '#1565C0', paddingHorizontal: 32, paddingVertical: 14,
    borderRadius: 12, marginBottom: 12,
  },
  permissionBtnText: { color: '#fff', fontWeight: '700', fontSize: 16 },
  backLink: { padding: 8 },
  backLinkText: { color: '#1565C0', fontSize: 15 },

  // ── Confirmation modal ────────────────────────────────────────────────────
  modalBackdrop: {
    flex: 1, justifyContent: 'flex-end',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32,
    maxHeight: '85%',
  },
  sheetHandle: {
    width: 40, height: 4, backgroundColor: '#e0e0e0',
    borderRadius: 2, alignSelf: 'center', marginBottom: 16,
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', marginBottom: 20,
  },
  sheetIconCircle: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: '#EBF2FF',
    justifyContent: 'center', alignItems: 'center',
    marginRight: 12,
  },
  sheetTitle: {
    fontSize: 20, fontWeight: '800', color: '#0D1B2E',
  },

  // Amount card
  amountCard: {
    backgroundColor: '#F0F7FF',
    borderRadius: 14, padding: 18,
    alignItems: 'center', marginBottom: 18,
    borderWidth: 1, borderColor: '#C5DFF8',
  },
  amountCardLabel: { fontSize: 12, color: '#555', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 0.5 },
  amountCardValue: { fontSize: 30, fontWeight: '900', color: '#1565C0', marginBottom: 2 },
  amountCardCurrency: { fontSize: 14, color: '#1565C0', fontWeight: '600' },

  // Detail rows
  detailRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: '#F0F0F0',
    gap: 8,
  },
  detailLabel: { fontSize: 14, color: '#888', width: 80 },
  detailValue: { fontSize: 14, color: '#0D1B2E', fontWeight: '600', flex: 1 },

  feeNote: {
    fontSize: 12, color: '#666', marginTop: 14, marginBottom: 4,
    textAlign: 'center', fontStyle: 'italic',
  },

  // Inputs (wallet_address type)
  inputLabel: { fontSize: 13, color: '#555', fontWeight: '600', marginTop: 14, marginBottom: 4 },
  input: {
    borderWidth: 1, borderColor: '#D0D0D0',
    borderRadius: 10, paddingHorizontal: 14, paddingVertical: 11,
    fontSize: 16, color: '#0D1B2E', backgroundColor: '#FAFAFA',
  },

  // Pay button
  payBtn: {
    backgroundColor: '#1565C0',
    borderRadius: 14, padding: 16,
    alignItems: 'center', marginTop: 22,
  },
  payBtnDisabled: { backgroundColor: '#90A4AE' },
  payBtnInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  payBtnText: { color: '#fff', fontSize: 17, fontWeight: '800' },

  cancelBtn: { marginTop: 10, alignItems: 'center', padding: 10 },
  cancelBtnText: { color: '#888', fontSize: 15 },
});
