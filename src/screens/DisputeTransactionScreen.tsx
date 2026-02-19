import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';

type DisputeReason = 'unauthorized' | 'wrong_amount' | 'not_received' | 'duplicate' | 'other';

type Transaction = {
  id: string;
  type: string;
  amount: number;
  currency: string;
  status: string;
  createdAt: number;
  memo?: string;
};

export default function DisputeTransactionScreen() {
  const auth = useAuth();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [selectedTransaction, setSelectedTransaction] = useState<Transaction | null>(null);
  const [disputeReason, setDisputeReason] = useState<DisputeReason>('unauthorized');
  const [description, setDescription] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState('');

  const disputeReasons: { value: DisputeReason; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
    { value: 'unauthorized', label: 'Unauthorized Transaction', icon: 'shield-outline' },
    { value: 'wrong_amount', label: 'Incorrect Amount', icon: 'calculator-outline' },
    { value: 'not_received', label: 'Payment Not Received', icon: 'close-circle-outline' },
    { value: 'duplicate', label: 'Duplicate Charge', icon: 'copy-outline' },
    { value: 'other', label: 'Other Issue', icon: 'ellipsis-horizontal-outline' },
  ];

  useEffect(() => {
    loadRecentTransactions();
  }, []);

  useEffect(() => {
    if (selectedTransaction && disputeReason) {
      generateAISuggestion();
    }
  }, [selectedTransaction, disputeReason]);

  async function loadRecentTransactions() {
    try {
      const res = await fetch(`${API_BASE}/transactions`, {
        headers: {
          'Authorization': `Bearer ${auth.token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        // Only show transactions from last 90 days
        const ninetyDaysAgo = Date.now() - (90 * 24 * 60 * 60 * 1000);
        const recent = data.filter((t: Transaction) => t.createdAt > ninetyDaysAgo);
        setTransactions(recent);
      }
    } catch (error) {
      console.error('Failed to load transactions:', error);
    } finally {
      setLoading(false);
    }
  }

  async function generateAISuggestion() {
    if (!selectedTransaction) return;

    const reasonLabels: Record<DisputeReason, string> = {
      unauthorized: 'This appears to be an unauthorized transaction. To help resolve this quickly:\n\n• Check if you recognize the recipient\n• Verify the transaction wasn\'t made by an authorized user\n• Review your recent device login history\n• Consider enabling biometric authentication\n\nWe\'ll investigate and may temporarily freeze your account for security.',
      wrong_amount: 'For incorrect amount disputes:\n\n• Verify the agreed-upon amount\n• Check for currency conversion fees (1.5%)\n• Review the transaction details\n• Provide any supporting documentation (receipts, messages)\n\nWe\'ll contact the recipient to confirm the correct amount.',
      not_received: 'If payment wasn\'t received:\n\n• Confirm the transaction status is "completed"\n• Verify the recipient\'s wallet ID\n• Check for network delays (usually < 1 minute)\n• Ask recipient to check their transaction history\n\nMost issues resolve within 24 hours. We\'ll track this payment.',
      duplicate: 'For duplicate charges:\n\n• Verify both transactions have the same amount and recipient\n• Check transaction timestamps\n• Review your send history\n\nWe\'ll refund one transaction if confirmed as duplicate.',
      other: 'Please provide detailed information about your issue. The more details you provide, the faster we can help resolve it.\n\nInclude:\n• What you expected to happen\n• What actually happened\n• Any error messages\n• Screenshots if available',
    };

    setAiSuggestion(reasonLabels[disputeReason]);
  }

  async function handleSubmitDispute() {
    if (!selectedTransaction) {
      Alert.alert('Error', 'Please select a transaction to dispute');
      return;
    }

    if (!description.trim()) {
      Alert.alert('Error', 'Please describe the issue');
      return;
    }

    setSubmitting(true);

    try {
      const res = await fetch(`${API_BASE}/disputes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${auth.token}`,
        },
        body: JSON.stringify({
          transactionId: selectedTransaction.id,
          reason: disputeReason,
          description: description.trim(),
          userEmail: auth.user?.email,
        }),
      });

      if (res.ok) {
        Alert.alert(
          'Dispute Submitted',
          'Your dispute has been submitted successfully. Our team will review it and respond within 2-3 business days. You\'ll receive updates via email.',
          [
            {
              text: 'OK',
              onPress: () => {
                setSelectedTransaction(null);
                setDescription('');
                setDisputeReason('unauthorized');
              },
            },
          ]
        );
      } else {
        throw new Error('Failed to submit dispute');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to submit dispute. Please try again or contact support@egwallet.com');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="alert-circle" size={48} color="#FF9500" />
        <Text style={styles.title}>Dispute Transaction</Text>
        <Text style={styles.subtitle}>
          We'll help resolve any issues with your transactions
        </Text>
      </View>

      {/* Select Transaction */}
      <View style={styles.section}>
        <Text style={styles.label}>Select Transaction to Dispute</Text>
        {transactions.length === 0 ? (
          <View style={styles.emptyState}>
            <Text style={styles.emptyText}>No recent transactions found</Text>
          </View>
        ) : (
          <View style={styles.transactionList}>
            {transactions.slice(0, 10).map(transaction => (
              <TouchableOpacity
                key={transaction.id}
                style={[
                  styles.transactionCard,
                  selectedTransaction?.id === transaction.id && styles.transactionCardSelected
                ]}
                onPress={() => setSelectedTransaction(transaction)}
              >
                <View style={styles.transactionIcon}>
                  <Ionicons 
                    name={transaction.type === 'send' ? 'arrow-up' : 'arrow-down'} 
                    size={20} 
                    color={selectedTransaction?.id === transaction.id ? '#007AFF' : '#657786'} 
                  />
                </View>
                <View style={styles.transactionInfo}>
                  <Text style={styles.transactionType}>{transaction.type}</Text>
                  <Text style={styles.transactionDate}>
                    {new Date(transaction.createdAt).toLocaleDateString()}
                  </Text>
                </View>
                <Text style={styles.transactionAmount}>
                  {(transaction.amount / 100).toFixed(2)} {transaction.currency}
                </Text>
                {selectedTransaction?.id === transaction.id && (
                  <Ionicons name="checkmark-circle" size={24} color="#007AFF" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {selectedTransaction && (
        <>
          {/* Dispute Reason */}
          <View style={styles.section}>
            <Text style={styles.label}>Reason for Dispute</Text>
            <View style={styles.reasonList}>
              {disputeReasons.map(reason => (
                <TouchableOpacity
                  key={reason.value}
                  style={[
                    styles.reasonCard,
                    disputeReason === reason.value && styles.reasonCardSelected
                  ]}
                  onPress={() => setDisputeReason(reason.value)}
                >
                  <Ionicons 
                    name={reason.icon} 
                    size={24} 
                    color={disputeReason === reason.value ? '#007AFF' : '#657786'} 
                  />
                  <Text style={[
                    styles.reasonLabel,
                    disputeReason === reason.value && styles.reasonLabelSelected
                  ]}>
                    {reason.label}
                  </Text>
                  {disputeReason === reason.value && (
                    <Ionicons name="checkmark-circle" size={20} color="#007AFF" />
                  )}
                </TouchableOpacity>
              ))}
            </View>
          </View>

          {/* AI Suggestion */}
          {aiSuggestion && (
            <View style={styles.aiSuggestionBox}>
              <View style={styles.aiHeader}>
                <Ionicons name="sparkles" size={20} color="#007AFF" />
                <Text style={styles.aiTitle}>AI Assistant Recommendation</Text>
              </View>
              <Text style={styles.aiText}>{aiSuggestion}</Text>
            </View>
          )}

          {/* Description */}
          <View style={styles.section}>
            <Text style={styles.label}>Describe the Issue</Text>
            <Text style={styles.hint}>
              Provide as much detail as possible to help us resolve this quickly
            </Text>
            <TextInput
              style={styles.textArea}
              value={description}
              onChangeText={setDescription}
              placeholder="What happened? Include any relevant details, amounts, dates, or communications..."
              placeholderTextColor="#AAB8C2"
              multiline
              numberOfLines={8}
              textAlignVertical="top"
              maxLength={1000}
            />
            <Text style={styles.charCount}>{description.length}/1000</Text>
          </View>

          {/* Submit Button */}
          <TouchableOpacity
            style={[styles.submitButton, submitting && styles.submitButtonDisabled]}
            onPress={handleSubmitDispute}
            disabled={submitting}
          >
            {submitting ? (
              <ActivityIndicator color="#FFFFFF" />
            ) : (
              <>
                <Ionicons name="checkmark-circle" size={20} color="#FFFFFF" />
                <Text style={styles.submitButtonText}>Submit Dispute</Text>
              </>
            )}
          </TouchableOpacity>

          <View style={styles.timelineInfo}>
            <Ionicons name="time" size={16} color="#657786" />
            <Text style={styles.timelineText}>
              Typical resolution time: 2-3 business days. You'll receive email updates.
            </Text>
          </View>
        </>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1C1E21',
    marginTop: 12,
  },
  subtitle: {
    fontSize: 14,
    color: '#657786',
    marginTop: 8,
    textAlign: 'center',
  },
  section: {
    padding: 16,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1E21',
    marginBottom: 12,
  },
  hint: {
    fontSize: 13,
    color: '#657786',
    marginBottom: 8,
    lineHeight: 18,
  },
  emptyState: {
    padding: 32,
    alignItems: 'center',
  },
  emptyText: {
    fontSize: 14,
    color: '#AAB8C2',
  },
  transactionList: {
    gap: 8,
  },
  transactionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#E1E8ED',
  },
  transactionCardSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#F0F7FF',
  },
  transactionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F5F7FA',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  transactionInfo: {
    flex: 1,
  },
  transactionType: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1E21',
    textTransform: 'capitalize',
  },
  transactionDate: {
    fontSize: 13,
    color: '#657786',
    marginTop: 2,
  },
  transactionAmount: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1C1E21',
    marginRight: 8,
  },
  reasonList: {
    gap: 12,
  },
  reasonCard: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#E1E8ED',
    gap: 12,
  },
  reasonCardSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#F0F7FF',
  },
  reasonLabel: {
    flex: 1,
    fontSize: 15,
    color: '#657786',
    fontWeight: '500',
  },
  reasonLabelSelected: {
    color: '#007AFF',
    fontWeight: '600',
  },
  aiSuggestionBox: {
    backgroundColor: '#F0F7FF',
    margin: 16,
    marginTop: 0,
    padding: 16,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  aiHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 12,
  },
  aiTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#007AFF',
  },
  aiText: {
    fontSize: 14,
    color: '#1C1E21',
    lineHeight: 20,
  },
  textArea: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E1E8ED',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: '#1C1E21',
    height: 150,
    textAlignVertical: 'top',
  },
  charCount: {
    fontSize: 12,
    color: '#AAB8C2',
    textAlign: 'right',
    marginTop: 4,
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
    marginHorizontal: 16,
    paddingVertical: 16,
    borderRadius: 12,
    gap: 10,
    marginBottom: 16,
  },
  submitButtonDisabled: {
    opacity: 0.6,
  },
  submitButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  timelineInfo: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    gap: 8,
  },
  timelineText: {
    flex: 1,
    fontSize: 13,
    color: '#657786',
    lineHeight: 18,
  },
});
