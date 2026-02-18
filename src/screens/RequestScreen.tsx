import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Alert, ActivityIndicator, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { createPaymentRequest, getPaymentRequests, cancelPaymentRequest } from '../api/transactions';
import { getCurrencySymbol } from '../utils/currency';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';

interface PaymentRequest {
  id: string;
  amount: number;
  currency: string;
  memo: string;
  status: 'pending' | 'paid' | 'cancelled';
  createdAt: number;
  paidAt: number | null;
}

export default function RequestScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const [loading, setLoading] = useState(false);
  const [requests, setRequests] = useState<PaymentRequest[]>([]);
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  
  // Form state
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [memo, setMemo] = useState('');

  useEffect(() => {
    loadRequests();
  }, []);

  const loadRequests = async () => {
    if (!isOnline) return;
    
    try {
      setLoading(true);
      const data = await getPaymentRequests(auth.token!);
      setRequests(data.requests || []);
    } catch (error: any) {
      if (__DEV__) console.log('Load requests error:', error);
      Alert.alert('Error', 'Failed to load payment requests. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreate = async () => {
    if (!amount || parseFloat(amount) <= 0) {
      Alert.alert('Error', 'Please enter a valid amount');
      return;
    }

    if (!isOnline) {
      Alert.alert('Offline', 'You need an internet connection to create payment requests');
      return;
    }

    if (isCreating) return; // Prevent duplicates

    const amountValue = parseFloat(amount);
    const amountMinor = Math.round(amountValue * 100);

    Alert.alert(
      'Create Payment Request',
      `Request ${getCurrencySymbol(currency)}${amountValue.toFixed(2)} ${currency}?${memo ? `\n\nMemo: ${memo}` : ''}`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: async () => {
            try {
              setIsCreating(true);
              setLoading(true);
              const wallets = auth.wallets || [];
              if (wallets.length === 0) {
                Alert.alert('Error', 'No wallet found');
                return;
              }

              await createPaymentRequest(
                auth.token!,
                wallets[0].id,
                amountMinor,
                currency,
                memo
              );

              Alert.alert('Success', 'Payment request created!');
              setAmount('');
              setMemo('');
              setShowCreateForm(false);
              loadRequests();
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to create request');
            } finally {
              setLoading(false);
              setIsCreating(false);
            }
          }
        }
      ]
    );
  };

  const handleShare = async (request: PaymentRequest) => {
    const link = `egwallet://pay-request/${request.id}`;
    const message = `Pay ${(request.amount / 100).toFixed(2)} ${request.currency} - ${request.memo || 'Payment Request'}\n\nLink: ${link}`;
    
    try {
      await Share.share({ message });
    } catch (error) {
      Alert.alert('Error', 'Failed to share link');
    }
  };

  const handleCancel = async (requestId: string) => {
    Alert.alert('Cancel Request', 'Are you sure?', [
      { text: 'No', style: 'cancel' },
      {
        text: 'Yes', onPress: async () => {
          try {
            setLoading(true);
            await cancelPaymentRequest(auth.token!, requestId);
            loadRequests();
          } catch (error: any) {
            Alert.alert('Error', error.message || 'Failed to cancel');
          } finally {
            setLoading(false);
          }
        }
      }
    ]);
  };

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };

  if (showCreateForm) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backButton} onPress={() => setShowCreateForm(false)}>
          <Ionicons name="arrow-back" size={24} color="#007AFF" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <Text style={styles.title}>Create Payment Request</Text>

        <View style={styles.form}>
          <Text style={styles.label}>Amount</Text>
          <TextInput
            style={styles.input}
            value={amount}
            onChangeText={setAmount}
            keyboardType="decimal-pad"
            placeholder="0.00"
            placeholderTextColor="#999"
          />

          <Text style={styles.label}>Currency</Text>
          <View style={styles.currencyPicker}>
            <Text style={styles.currencyText}>{currency} {getCurrencySymbol(currency)}</Text>
          </View>

          <Text style={styles.label}>Memo (Optional)</Text>
          <TextInput
            style={[styles.input, styles.memoInput]}
            value={memo}
            onChangeText={setMemo}
            placeholder="What's this for?"
            placeholderTextColor="#999"
            multiline
          />

          <TouchableOpacity
            style={styles.createButton}
            onPress={handleCreate}
            disabled={loading}
          >
            {loading ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="add-circle" size={20} color="#FFFFFF" />
                <Text style={styles.createButtonText}>Create Request</Text>
              </>
            )}
          </TouchableOpacity>
        </View>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <OfflineErrorBanner />
      <View style={styles.header}>
        <Text style={styles.title}>Payment Requests</Text>
        <TouchableOpacity
          style={styles.addButton}
          onPress={() => setShowCreateForm(true)}
        >
          <Ionicons name="add" size={24} color="#007AFF" />
        </TouchableOpacity>
      </View>

      {loading && requests.length === 0 ? (
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color="#007AFF" />
        </View>
      ) : requests.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="download-outline" size={64} color="#CCCCCC" />
          <Text style={styles.emptyTitle}>No Payment Requests</Text>
          <Text style={styles.emptyText}>Create your first request to receive money</Text>
        </View>
      ) : (
        <View style={styles.list}>
          {requests.map((request) => (
            <View key={request.id} style={styles.requestCard}>
              <View style={styles.requestHeader}>
                <View style={[
                  styles.statusBadge,
                  request.status === 'paid' && styles.statusPaid,
                  request.status === 'cancelled' && styles.statusCancelled
                ]}>
                  <Text style={[
                    styles.statusText,
                    request.status === 'paid' && { color: '#2E7D32' },
                    request.status === 'cancelled' && { color: '#d32f2f' }
                  ]}>{request.status.toUpperCase()}</Text>
                </View>
                <Text style={styles.dateText}>{formatDate(request.createdAt)}</Text>
              </View>

              <Text style={styles.amountText}>
                {getCurrencySymbol(request.currency)}{(request.amount / 100).toFixed(2)} {request.currency}
              </Text>
              
              {request.memo && (
                <Text style={styles.memoText}>{request.memo}</Text>
              )}

              {request.status === 'pending' && (
                <View style={styles.actions}>
                  <TouchableOpacity
                    style={styles.shareButton}
                    onPress={() => handleShare(request)}
                  >
                    <Ionicons name="share-social" size={18} color="#007AFF" />
                    <Text style={styles.shareButtonText}>Share</Text>
                  </TouchableOpacity>

                  <TouchableOpacity
                    style={styles.cancelButton}
                    onPress={() => handleCancel(request.id)}
                  >
                    <Ionicons name="close-circle" size={18} color="#d32f2f" />
                    <Text style={styles.cancelButtonText}>Cancel</Text>
                  </TouchableOpacity>
                </View>
              )}

              {request.status === 'paid' && request.paidAt && (
                <Text style={styles.paidText}>Paid on {formatDate(request.paidAt)}</Text>
              )}
            </View>
          ))}
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  content: {
    padding: 16,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: '#14171A',
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#E8F5FE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingContainer: {
    paddingVertical: 64,
    alignItems: 'center',
  },
  emptyContainer: {
    paddingVertical: 64,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#14171A',
    marginTop: 16,
  },
  emptyText: {
    fontSize: 14,
    color: '#657786',
    marginTop: 8,
  },
  list: {
    gap: 12,
  },
  requestCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  requestHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  statusBadge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 12,
    backgroundColor: '#FFF3E0',
  },
  statusPaid: {
    backgroundColor: '#E8F5E9',
  },
  statusCancelled: {
    backgroundColor: '#FFEBEE',
  },
  statusText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#F57C00',
  },
  dateText: {
    fontSize: 13,
    color: '#657786',
  },
  amountText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#14171A',
    marginBottom: 8,
  },
  memoText: {
    fontSize: 14,
    color: '#657786',
    marginBottom: 12,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
    marginTop: 12,
  },
  shareButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#E8F5FE',
    gap: 6,
  },
  shareButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
  cancelButton: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 12,
    borderRadius: 8,
    backgroundColor: '#FFEBEE',
    gap: 6,
  },
  cancelButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#d32f2f',
  },
  paidText: {
    fontSize: 13,
    color: '#2E7D32',
    marginTop: 8,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    gap: 8,
  },
  backText: {
    fontSize: 16,
    color: '#007AFF',
  },
  form: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 8,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#F5F7FA',
    borderRadius: 8,
    padding: 14,
    fontSize: 16,
    color: '#14171A',
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  memoInput: {
    height: 80,
    textAlignVertical: 'top',
  },
  currencyPicker: {
    backgroundColor: '#F5F7FA',
    borderRadius: 8,
    padding: 14,
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  currencyText: {
    fontSize: 16,
    color: '#14171A',
    fontWeight: '600',
  },
  createButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
    borderRadius: 8,
    padding: 16,
    marginTop: 24,
    gap: 8,
  },
  createButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
});
