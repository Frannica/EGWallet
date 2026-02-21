import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ActivityIndicator, Alert, ScrollView } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { useRoute, useNavigation } from '@react-navigation/native';
import { formatCurrency } from '../utils/currency';
import QRCode from 'react-native-qrcode-svg';
import { protectedApiCall, generateIdempotencyKey, showErrorAlert } from '../api/protectedClient';

type PaymentState = 'idle' | 'processing' | 'success' | 'error';

type PaymentResponse = {
  success: boolean;
  transaction: {
    id: string;
    type: string;
    amount: number;
    currency: string;
  };
  isIdempotent: boolean;
};

export default function QRPaymentScreen() {
  const auth = useAuth();
  const route = useRoute();
  const navigation = useNavigation();
  
  const [paymentState, setPaymentState] = useState<PaymentState>('idle');
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string>('');
  
  // Idempotency key - generated once and persisted across retries
  const idempotencyKeyRef = useRef<string>(generateIdempotencyKey('qr_pay_'));
  
  // @ts-ignore
  const { employerId, employerName, amount, currency, batchId, verified, requestId } = route.params || {};

  const qrData = JSON.stringify({
    type: 'payroll_payment',
    employerId,
    employerName,
    amount,
    currency,
    batchId,
    requestId,
    timestamp: Date.now()
  });

  async function handleConfirmPayment() {
    if (!auth.token) {
      Alert.alert('Error', 'Not authenticated');
      return;
    }
    
    // Prevent double submission
    if (paymentState === 'processing' || paymentState === 'success') {
      return;
    }
    
    Alert.alert(
      'Confirm Payment',
      `Pay ${formatCurrency(amount, currency)} to ${employerName}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Confirm',
          onPress: () => executePayment(),
        }
      ]
    );
  }

  async function executePayment() {
    setPaymentState('processing');
    setErrorMessage('');
    
    try {
      const { API_BASE } = await import('../api/client');
      
      const { data, error } = await protectedApiCall<PaymentResponse>(
        `${API_BASE}/payroll/confirm-payment`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({
            employerId,
            batchId,
            amount,
            currency,
            requestId
          }),
        },
        {
          timeout: 20000, // 20 second timeout for payment
          retries: 2, // Retry twice on network errors
          idempotencyKey: idempotencyKeyRef.current, // Prevent double charge
        }
      );

      if (error) {
        setPaymentState('error');
        setErrorMessage(error.message);
        showErrorAlert(error, () => executePayment()); // Show retry option
        return;
      }

      if (!data || !data.success) {
        throw new Error('Payment failed');
      }

      // Success!
      setTransactionId(data.transaction.id);
      setPaymentState('success');
    } catch (error: any) {
      setPaymentState('error');
      setErrorMessage(error.message || 'Payment failed');
      Alert.alert('Error', error.message || 'Payment failed');
    }
  }

  // Success Receipt Screen
  if (paymentState === 'success') {
    return (
      <View style={styles.container}>
        <View style={styles.header}>
          <Ionicons name="checkmark-circle" size={80} color="#FFFFFF" />
          <Text style={styles.successTitle}>Payment Confirmed!</Text>
        </View>

        <View style={styles.content}>
          <View style={styles.receiptCard}>
            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Amount Paid</Text>
              <Text style={styles.receiptValue}>{formatCurrency(amount, currency)}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>To</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Text style={styles.receiptValue}>{employerName}</Text>
                {verified && (
                  <Ionicons name="checkmark-circle" size={16} color="#2E7D32" />
                )}
              </View>
            </View>

            <View style={styles.divider} />

            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Batch ID</Text>
              <Text style={styles.receiptValue}>{batchId}</Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Transaction ID</Text>
              <Text style={[styles.receiptValue, { fontSize: 12, color: '#657786' }]}>
                {transactionId}
              </Text>
            </View>

            <View style={styles.divider} />

            <View style={styles.receiptRow}>
              <Text style={styles.receiptLabel}>Date</Text>
              <Text style={styles.receiptValue}>
                {new Date().toLocaleDateString()}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            style={styles.doneButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.doneButtonText}>Done</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Error State with Retry
  if (paymentState === 'error') {
    return (
      <View style={styles.container}>
        <View style={[styles.header, { backgroundColor: '#d32f2f' }]}>
          <Ionicons name="alert-circle" size={80} color="#FFFFFF" />
          <Text style={styles.successTitle}>Payment Failed</Text>
        </View>

        <View style={styles.content}>
          <View style={styles.errorCard}>
            <Text style={styles.errorMessage}>{errorMessage}</Text>
            
            <Text style={styles.errorHelp}>
              {errorMessage.includes('connection') || errorMessage.includes('network')
                ? 'Check your internet connection and try again.'
                : errorMessage.includes('timeout')
                ? 'The request took too long. Please check your connection and try again.'
                : 'If the problem persists, please contact support.'}
            </Text>
          </View>

          <TouchableOpacity
            style={styles.retryButton}
            onPress={() => {
              setPaymentState('idle');
              setErrorMessage('');
            }}
          >
            <Ionicons name="reload" size={20} color="#FFFFFF" />
            <Text style={styles.retryButtonText}>Try Again</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.cancelButton}
            onPress={() => navigation.goBack()}
          >
            <Text style={styles.cancelButtonText}>Cancel</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // Default Payment Screen

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.headerTitle}>Pay {employerName}</Text>
      </View>

      <View style={styles.content}>
        <Text style={styles.amountLabel}>Amount to Pay</Text>
        <Text style={styles.amountValue}>{formatCurrency(amount, currency)}</Text>

        <View style={styles.qrContainer}>
          <QRCode
            value={qrData}
            size={220}
            backgroundColor="white"
          />
          <Text style={styles.qrLabel}>Scan to Pay</Text>
        </View>

        <View style={styles.detailsCard}>
          <View style={styles.detailRow}>
            <Ionicons name="business" size={20} color="#1976D2" />
            <Text style={styles.detailText}>{employerName}</Text>
            {verified && (
              <View style={styles.verifiedBadge}>
                <Ionicons name="checkmark-circle" size={16} color="#2E7D32" />
              </View>
            )}
          </View>

          <View style={styles.detailRow}>
            <Ionicons name="document-text" size={20} color="#1976D2" />
            <Text style={styles.detailText}>Batch {batchId}</Text>
          </View>

          <View style={styles.detailRow}>
            <Ionicons name="calendar" size={20} color="#1976D2" />
            <Text style={styles.detailText}>January 2026 Salary</Text>
          </View>

          <View style={styles.detailRow}>
            <Ionicons name="shield-checkmark" size={20} color="#2E7D32" />
            <Text style={styles.secureText}>Secure & Verified</Text>
          </View>
        </View>

        <TouchableOpacity
          style={[
            styles.confirmButton, 
            paymentState === 'processing' && styles.confirmButtonDisabled
          ]}
          onPress={handleConfirmPayment}
          disabled={paymentState === 'processing' || paymentState === 'success'}
        >
          {paymentState === 'processing' ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <Text style={styles.confirmButtonText}>Confirm Payment</Text>
          )}
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#4A90E2',
  },
  header: {
    paddingTop: 60,
    paddingBottom: 20,
    paddingHorizontal: 20,
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  content: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    padding: 24,
    alignItems: 'center',
  },
  amountLabel: {
    fontSize: 14,
    color: '#657786',
    marginBottom: 8,
  },
  amountValue: {
    fontSize: 32,
    fontWeight: 'bold',
    color: '#1976D2',
    marginBottom: 32,
  },
  qrContainer: {
    backgroundColor: '#FFFFFF',
    padding: 24,
    borderRadius: 16,
    alignItems: 'center',
    marginBottom: 24,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 4,
  },
  qrLabel: {
    marginTop: 16,
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
  },
  detailsCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    marginBottom: 24,
    gap: 16,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  detailText: {
    flex: 1,
    fontSize: 15,
    color: '#14171A',
    fontWeight: '500',
  },
  secureText: {
    flex: 1,
    fontSize: 15,
    color: '#2E7D32',
    fontWeight: '600',
  },
  verifiedBadge: {
    marginLeft: 'auto',
  },
  confirmButton: {
    width: '100%',
    backgroundColor: '#1976D2',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  confirmButtonDisabled: {
    opacity: 0.6,
  },
  confirmButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  // Success Receipt Styles
  successTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#FFFFFF',
    marginTop: 16,
  },
  receiptCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 24,
    marginBottom: 24,
  },
  receiptRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
  },
  receiptLabel: {
    fontSize: 14,
    color: '#657786',
  },
  receiptValue: {
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
  },
  divider: {
    height: 1,
    backgroundColor: '#E1E8ED',
  },
  doneButton: {
    width: '100%',
    backgroundColor: '#2E7D32',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
  },
  doneButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  // Error State Styles
  errorCard: {
    width: '100%',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 24,
    marginBottom: 24,
  },
  errorMessage: {
    fontSize: 16,
    fontWeight: '600',
    color: '#d32f2f',
    marginBottom: 12,
    textAlign: 'center',
  },
  errorHelp: {
    fontSize: 14,
    color: '#657786',
    textAlign: 'center',
    lineHeight: 20,
  },
  retryButton: {
    width: '100%',
    backgroundColor: '#1976D2',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 12,
  },
  retryButtonText: {
    fontSize: 16,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  cancelButton: {
    width: '100%',
    backgroundColor: 'transparent',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#657786',
  },
  cancelButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#657786',
  },
});
