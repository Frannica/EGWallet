import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, Alert, ScrollView, TouchableOpacity, StyleSheet, ActivityIndicator, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { listWallets } from '../api/auth';
import { sendTransaction } from '../api/transactions';
import { useNavigation } from '@react-navigation/native';
import { majorToMinor, decimalsFor, formatCurrency } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';

const FEE_PERCENTAGE = 0.01; // 1% fee

export default function SendScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const [wallets, setWallets] = useState<Array<any>>([]);
  const [loading, setLoading] = useState(false);
  const [fromWalletId, setFromWalletId] = useState<string | null>(null);
  const [toWalletId, setToWalletId] = useState<string>('');
  const [amount, setAmount] = useState<string>('');
  const [currency, setCurrency] = useState<string>('XAF');
  const [showConfirmation, setShowConfirmation] = useState(false);
  const [scamAcknowledged, setScamAcknowledged] = useState(false);
  const [showScamTips, setShowScamTips] = useState(false);
  const navigation = useNavigation();

  useEffect(() => { loadWallets(); }, [auth.token]);

  async function loadWallets() {
    if (!auth.token) return;
    setLoading(true);
    try {
      const res = await listWallets(auth.token);
      setWallets(res.wallets || []);
      if ((res.wallets || []).length > 0) setFromWalletId((res.wallets || [])[0].id);
    } catch (e) {
      if (__DEV__) console.warn(e);
    } finally { setLoading(false); }
  }

  async function onSend() {
    if (!auth.token) return Alert.alert('Error', 'Not authenticated');
    if (!fromWalletId) return Alert.alert('Error', 'Select source wallet');
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return Alert.alert('Error', 'Enter valid amount');
    if (!toWalletId.trim()) return Alert.alert('Error', 'Enter destination wallet ID');
    
    setScamAcknowledged(false); // Reset checkbox for new confirmation
    setShowConfirmation(true);
  }

  function calculatePreview() {
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return null;

    const fee = amt * FEE_PERCENTAGE;
    const total = amt + fee;

    return {
      amount: amt,
      fee,
      total,
      recipientGets: amt,
    };
  }

  function isHighAmount(): boolean {
    const amt = parseFloat(amount);
    if (!amt) return false;
    // High amount thresholds (in major currency units)
    const thresholds: Record<string, number> = {
      USD: 500,
      EUR: 500,
      GBP: 400,
      XAF: 300000,
      NGN: 200000,
      GHS: 3000,
      ZAR: 8000,
      KES: 50000,
    };
    return amt >= (thresholds[currency] || 500);
  }

  async function onSendConfirmed() {
    if (!auth.token) return Alert.alert('Error', 'Not authenticated');
    if (!fromWalletId) return Alert.alert('Error', 'Select source wallet');
    const amt = parseFloat(amount);
    if (!amt || amt <= 0) return Alert.alert('Error', 'Enter valid amount');
    const amountMinor = majorToMinor(amt, currency);
    if (!toWalletId) return Alert.alert('Error', 'Enter destination wallet ID');
    
    // Check scam acknowledgement for high amounts
    if (isHighAmount() && !scamAcknowledged) {
      return Alert.alert('Acknowledgement Required', 'Please confirm you understand the scam warning before sending.');
    }

    setLoading(true);
    try {
      const res = await sendTransaction(auth.token, fromWalletId, toWalletId, amountMinor, currency);
      Alert.alert('Success', 'Transaction completed successfully!');
      loadWallets();
      setAmount('');
      setShowConfirmation(false);
      // @ts-ignore
      navigation.navigate('Transactions' as any, { walletId: fromWalletId } as any);
    } catch (e: any) {
      Alert.alert('Transaction Failed', e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  const preview = calculatePreview();
  const CURRENCIES = ['XAF', 'USD', 'EUR', 'GBP', 'NGN', 'GHS', 'ZAR', 'KES'];

  // Scam Tips Modal
  const ScamTipsModal = () => (
    <Modal
      visible={showScamTips}
      transparent
      animationType="slide"
      onRequestClose={() => setShowScamTips(false)}
    >
      <View style={styles.modalOverlay}>
        <View style={styles.modalContent}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>🚨 Scam Warning Signs</Text>
            <TouchableOpacity onPress={() => setShowScamTips(false)}>
              <Ionicons name="close" size={24} color="#14171A" />
            </TouchableOpacity>
          </View>
          
          <ScrollView style={styles.modalScroll}>
            <View style={styles.tipItem}>
              <Ionicons name="alert-circle" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>Pressure to send money quickly</Text>
                <Text style={styles.tipText}>Scammers create urgency. Take your time to verify.</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="heart-dislike" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>Romance or friendship scams</Text>
                <Text style={styles.tipText}>Never send money to people you met online and haven't met in person.</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="trophy" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>"You won!" messages</Text>
                <Text style={styles.tipText}>Legitimate prizes don't require upfront payment or fees.</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="shield-checkmark" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>Impersonation scams</Text>
                <Text style={styles.tipText}>Verify identities through official channels, not links they provide.</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="card" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>Investment opportunities</Text>
                <Text style={styles.tipText}>Be wary of guaranteed high returns or "insider" opportunities.</Text>
              </View>
            </View>
            
            <View style={styles.tipItem}>
              <Ionicons name="hand-left" size={24} color="#D32F2F" />
              <View style={styles.tipContent}>
                <Text style={styles.tipTitle}>Charity scams</Text>
                <Text style={styles.tipText}>Verify charities through official databases before donating.</Text>
              </View>
            </View>
            
            <View style={styles.safetyBox}>
              <Ionicons name="checkmark-circle" size={24} color="#2E7D32" />
              <Text style={styles.safetyText}>
                <Text style={styles.safetyBold}>Stay Safe:</Text> Only send money to people you know and trust personally. When in doubt, stop and verify.
              </Text>
            </View>
          </ScrollView>
          
          <TouchableOpacity 
            style={styles.modalCloseButton} 
            onPress={() => setShowScamTips(false)}
          >
            <Text style={styles.modalCloseText}>Got it</Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // Confirmation screen
  if (showConfirmation && preview) {
    return (
      <View style={styles.container}>
        <ScamTipsModal />
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.confirmHeader}>
            <Text style={styles.confirmTitle}>Review Transaction</Text>
            <Text style={styles.confirmSubtitle}>Please confirm the details below</Text>
          </View>

          <View style={styles.summaryCard}>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>From Wallet</Text>
              <Text style={styles.summaryValue}>{fromWalletId?.substring(0, 12)}...</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>To Wallet</Text>
              <Text style={styles.summaryValue}>{toWalletId.substring(0, 12)}...</Text>
            </View>
            <View style={styles.summaryRow}>
              <Text style={styles.summaryLabel}>Currency</Text>
              <Text style={styles.summaryValueBold}>{currency}</Text>
            </View>
          </View>

          <View style={styles.amountCard}>
            <View style={styles.amountRow}>
              <Text style={styles.amountLabel}>Amount</Text>
              <Text style={styles.amountValue}>{formatCurrency(preview.amount * 100, currency)}</Text>
            </View>
            <View style={styles.amountRow}>
              <Text style={styles.amountLabel}>Transaction Fee (1%)</Text>
              <Text style={styles.feeValue}>-{formatCurrency(preview.fee * 100, currency)}</Text>
            </View>
            <View style={[styles.amountRow, styles.totalRow]}>
              <Text style={styles.totalLabel}>Total Charge</Text>
              <Text style={styles.totalValue}>{formatCurrency(preview.total * 100, currency)}</Text>
            </View>
            <View style={styles.recipientRow}>
              <Text style={styles.recipientLabel}>Recipient Receives</Text>
              <Text style={styles.recipientValue}>{formatCurrency(preview.recipientGets * 100, currency)}</Text>
            </View>
          </View>

          <View style={styles.infoBox}>
            <Text style={styles.infoText}>
              ℹ️ The recipient will receive the funds in their preferred currency based on current exchange rates.
            </Text>
          </View>

          {/* Scam Warning */}
          <View style={styles.scamWarning}>
            <View style={styles.scamWarningHeader}>
              <Ionicons name="warning" size={20} color="#D32F2F" />
              <Text style={styles.scamWarningTitle}>Scam warning</Text>
            </View>
            <Text style={styles.scamWarningText}>
              Don't send money to charities, people you met online, or anyone you don't personally know. If someone is pressuring you, stop and verify first.
            </Text>
            <TouchableOpacity 
              style={styles.learnMoreButton}
              onPress={() => setShowScamTips(true)}
            >
              <Text style={styles.learnMoreText}>Learn scam signs</Text>
              <Ionicons name="chevron-forward" size={16} color="#007AFF" />
            </TouchableOpacity>
          </View>

          {/* Scam Acknowledgement Checkbox */}
          {isHighAmount() && (
            <TouchableOpacity 
              style={styles.checkboxContainer}
              onPress={() => setScamAcknowledged(!scamAcknowledged)}
              activeOpacity={0.7}
            >
              <View style={[styles.checkbox, scamAcknowledged && styles.checkboxChecked]}>
                {scamAcknowledged && (
                  <Ionicons name="checkmark" size={16} color="#FFFFFF" />
                )}
              </View>
              <Text style={styles.checkboxLabel}>
                I understand. I'm sending to someone I trust.
              </Text>
            </TouchableOpacity>
          )}

          <View style={styles.buttonContainer}>
            <TouchableOpacity 
              style={[styles.button, styles.cancelButton]} 
              onPress={() => setShowConfirmation(false)}
              disabled={loading}
            >
              <Text style={styles.cancelButtonText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={[
                styles.button, 
                styles.confirmButton,
                (loading || (isHighAmount() && !scamAcknowledged)) && styles.confirmButtonDisabled
              ]} 
              onPress={onSendConfirmed}
              disabled={loading || (isHighAmount() && !scamAcknowledged)}
            >
              {loading ? (
                <ActivityIndicator color="#FFFFFF" />
              ) : (
                <Text style={styles.confirmButtonText}>Confirm & Send</Text>
              )}
            </TouchableOpacity>
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <OfflineErrorBanner visible={!isOnline} onRetry={() => loadWallets()} />
      <ScamTipsModal />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.header}>
          <Text style={styles.title}>Send Money</Text>
          <Text style={styles.subtitle}>Transfer funds to another wallet</Text>
        </View>

        {loading && wallets.length === 0 ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={styles.loadingText}>Loading wallets...</Text>
          </View>
        ) : (
          <>
            <View style={styles.section}>
              <Text style={styles.label}>From Wallet</Text>
              {wallets.length === 0 ? (
                <View style={styles.emptyWallet}>
                  <Text style={styles.emptyWalletText}>No wallets available</Text>
                </View>
              ) : (
                <View style={styles.walletSelector}>
                  {wallets.map(w => (
                    <TouchableOpacity
                      key={w.id}
                      onPress={() => setFromWalletId(w.id)}
                      style={[
                        styles.walletOption,
                        fromWalletId === w.id && styles.walletOptionSelected
                      ]}
                    >
                      <Text style={[
                        styles.walletOptionText,
                        fromWalletId === w.id && styles.walletOptionTextSelected
                      ]}>
                        {w.id.substring(0, 12)}...
                      </Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>To Wallet ID</Text>
              <TextInput
                value={toWalletId}
                onChangeText={setToWalletId}
                placeholder="Enter destination wallet ID"
                placeholderTextColor="#AAB8C2"
                editable={!loading}
                style={styles.input}
              />
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>Amount</Text>
              <View style={styles.amountInputContainer}>
                <TextInput
                  value={amount}
                  onChangeText={setAmount}
                  placeholder="0.00"
                  placeholderTextColor="#AAB8C2"
                  keyboardType="decimal-pad"
                  editable={!loading}
                  style={styles.amountInput}
                />
                <View style={styles.currencyBadge}>
                  <Text style={styles.currencyBadgeText}>{currency}</Text>
                </View>
              </View>
            </View>

            <View style={styles.section}>
              <Text style={styles.label}>Currency</Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.currencyScroll}>
                {CURRENCIES.map(c => (
                  <TouchableOpacity
                    key={c}
                    onPress={() => setCurrency(c)}
                    style={[styles.currencyButton, currency === c && styles.currencyButtonActive]}
                  >
                    <Text style={[styles.currencyButtonText, currency === c && styles.currencyButtonTextActive]}>
                      {c}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>

            <View style={styles.infoBox}>
              <Text style={styles.infoText}>
                ℹ️ A 1% transaction fee will be applied to this transfer.
              </Text>
            </View>

            {/* Scam Warning Banner on Send Screen */}
            <View style={styles.scamBanner}>
              <View style={styles.scamBannerHeader}>
                <Ionicons name="shield-checkmark" size={18} color="#D32F2F" />
                <Text style={styles.scamBannerTitle}>Scam warning</Text>
              </View>
              <Text style={styles.scamBannerText}>
                Only send to people you know and trust.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.sendButton, (!amount || !toWalletId || loading || !isOnline) && styles.sendButtonDisabled]}
              onPress={onSend}
              disabled={!amount || !toWalletId || loading || !isOnline}
            >
              <Text style={styles.sendButtonText}>Review Transaction</Text>
            </TouchableOpacity>
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  scrollContent: {
    padding: 16,
  },
  header: {
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 4,
  },
  subtitle: {
    fontSize: 14,
    color: '#657786',
  },
  loadingContainer: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
    color: '#657786',
  },
  section: {
    marginBottom: 20,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 8,
  },
  walletSelector: {
    gap: 8,
  },
  walletOption: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#E1E8ED',
  },
  walletOptionSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#E8F5FE',
  },
  walletOptionText: {
    fontSize: 14,
    color: '#14171A',
    fontWeight: '500',
  },
  walletOptionTextSelected: {
    color: '#007AFF',
    fontWeight: '600',
  },
  emptyWallet: {
    padding: 16,
    backgroundColor: '#FFF3E0',
    borderRadius: 8,
  },
  emptyWalletText: {
    color: '#E65100',
    fontSize: 14,
  },
  input: {
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E1E8ED',
    fontSize: 16,
    color: '#14171A',
  },
  amountInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  amountInput: {
    flex: 1,
    padding: 16,
    fontSize: 24,
    fontWeight: '600',
    color: '#14171A',
  },
  currencyBadge: {
    backgroundColor: '#F5F8FA',
    paddingHorizontal: 16,
    paddingVertical: 8,
    marginRight: 8,
    borderRadius: 6,
  },
  currencyBadgeText: {
    fontSize: 14,
    fontWeight: 'bold',
    color: '#657786',
  },
  currencyScroll: {
    flexGrow: 0,
  },
  currencyButton: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    backgroundColor: '#FFFFFF',
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  currencyButtonActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  currencyButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
  },
  currencyButtonTextActive: {
    color: '#FFFFFF',
  },
  infoBox: {
    backgroundColor: '#E8F5FE',
    padding: 12,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
    marginBottom: 20,
  },
  infoText: {
    fontSize: 13,
    color: '#01579B',
    lineHeight: 18,
  },
  sendButton: {
    backgroundColor: '#007AFF',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  sendButtonDisabled: {
    backgroundColor: '#AAB8C2',
    shadowOpacity: 0,
    elevation: 0,
  },
  sendButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  // Confirmation Screen Styles
  confirmHeader: {
    marginBottom: 24,
  },
  confirmTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 4,
  },
  confirmSubtitle: {
    fontSize: 14,
    color: '#657786',
  },
  summaryCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  summaryRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F8FA',
  },
  summaryLabel: {
    fontSize: 14,
    color: '#657786',
  },
  summaryValue: {
    fontSize: 14,
    color: '#14171A',
    fontWeight: '500',
  },
  summaryValueBold: {
    fontSize: 14,
    color: '#14171A',
    fontWeight: 'bold',
  },
  amountCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  amountRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
  },
  amountLabel: {
    fontSize: 14,
    color: '#657786',
  },
  amountValue: {
    fontSize: 14,
    color: '#14171A',
    fontWeight: '500',
  },
  feeValue: {
    fontSize: 14,
    color: '#D32F2F',
    fontWeight: '500',
  },
  totalRow: {
    borderTopWidth: 2,
    borderTopColor: '#E1E8ED',
    marginTop: 8,
    paddingTop: 12,
  },
  totalLabel: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#14171A',
  },
  totalValue: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#14171A',
  },
  recipientRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 8,
    backgroundColor: '#E8F5E9',
    marginTop: 8,
    padding: 12,
    borderRadius: 8,
  },
  recipientLabel: {
    fontSize: 14,
    color: '#2E7D32',
    fontWeight: '600',
  },
  recipientValue: {
    fontSize: 14,
    color: '#2E7D32',
    fontWeight: 'bold',
  },
  buttonContainer: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  button: {
    flex: 1,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  cancelButton: {
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: '#E1E8ED',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#657786',
  },
  confirmButton: {
    backgroundColor: '#007AFF',
    shadowColor: '#007AFF',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  confirmButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  confirmButtonDisabled: {
    backgroundColor: '#AAB8C2',
    shadowOpacity: 0,
    elevation: 0,
  },
  // Scam Warning Styles
  scamBanner: {
    backgroundColor: '#FFF3E0',
    padding: 12,
    borderRadius: 8,
    borderLeftWidth: 4,
    borderLeftColor: '#FF6F00',
    marginBottom: 16,
  },
  scamBannerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 4,
  },
  scamBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
    color: '#E65100',
  },
  scamBannerText: {
    fontSize: 12,
    color: '#E65100',
    lineHeight: 16,
  },
  scamWarning: {
    backgroundColor: '#FFEBEE',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#EF5350',
    marginBottom: 16,
  },
  scamWarningHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 8,
  },
  scamWarningTitle: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#C62828',
  },
  scamWarningText: {
    fontSize: 14,
    color: '#C62828',
    lineHeight: 20,
    marginBottom: 12,
  },
  learnMoreButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  learnMoreText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  checkboxContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 2,
    borderColor: '#007AFF',
    marginBottom: 16,
  },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: '#AAB8C2',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  checkboxChecked: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  checkboxLabel: {
    flex: 1,
    fontSize: 14,
    color: '#14171A',
    fontWeight: '500',
  },
  // Scam Tips Modal Styles
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'flex-end',
  },
  modalContent: {
    backgroundColor: '#FFFFFF',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: '80%',
    paddingBottom: 32,
  },
  modalHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  modalTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#14171A',
  },
  modalScroll: {
    padding: 20,
  },
  tipItem: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 20,
    paddingBottom: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F8FA',
  },
  tipContent: {
    flex: 1,
  },
  tipTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: '#14171A',
    marginBottom: 4,
  },
  tipText: {
    fontSize: 14,
    color: '#657786',
    lineHeight: 20,
  },
  safetyBox: {
    flexDirection: 'row',
    gap: 12,
    backgroundColor: '#E8F5E9',
    padding: 16,
    borderRadius: 12,
    marginTop: 8,
  },
  safetyText: {
    flex: 1,
    fontSize: 14,
    color: '#2E7D32',
    lineHeight: 20,
  },
  safetyBold: {
    fontWeight: '700',
  },
  modalCloseButton: {
    backgroundColor: '#007AFF',
    marginHorizontal: 20,
    marginTop: 16,
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  modalCloseText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
});

