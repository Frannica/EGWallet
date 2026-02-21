import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { createVirtualCard, getVirtualCards, toggleCardFreeze, deleteVirtualCard } from '../api/transactions';
import { listWallets } from '../api/auth';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { CardSkeleton } from '../components/SkeletonLoader';

interface VirtualCard {
  id: string;
  cardNumber: string;
  cvv: string;
  expiryMonth: string;
  expiryYear: string;
  currency: string;
  label: string;
  status: 'active' | 'frozen';
}

export default function CardScreen() {
  const auth = useAuth();
  const { isOnline } = useNetworkStatus();
  const [loading, setLoading] = useState(false);
  const [cards, setCards] = useState<VirtualCard[]>([]);
  const [selectedCard, setSelectedCard] = useState<VirtualCard | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [wallets, setWallets] = useState<any[]>([]);

  useEffect(() => {
    loadCards();
    loadWallets();
  }, []);

  const loadWallets = async () => {
    if (!auth.token) return;
    try {
      const res = await listWallets(auth.token);
      setWallets(res.wallets || []);
    } catch (e) {
      if (__DEV__) console.warn('Failed to load wallets', e);
    }
  };

  const loadCards = async () => {
    if (!isOnline) return;
    
    try {
      setLoading(true);
      const data = await getVirtualCards(auth.token!);
      setCards(data.cards || []);
    } catch (error: any) {
      if (__DEV__) console.log('Load cards error:', error);
      Alert.alert('Error', 'Failed to load virtual cards. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCard = async () => {
    if (!isOnline) {
      Alert.alert('Offline', 'You need an internet connection to create virtual cards');
      return;
    }

    if (isCreating) return; // Prevent duplicates

    if (wallets.length === 0) {
      Alert.alert('Error', 'No wallet found');
      return;
    }

    Alert.alert(
      'Create Virtual Card',
      'Create a new virtual card for online payments? Daily limit: $1,000 USD',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Create',
          onPress: async () => {
            try {
              setIsCreating(true);
              setLoading(true);
              await createVirtualCard(auth.token!, wallets[0].id, 'USD', 'My Virtual Card');
              Alert.alert('Success', 'Virtual card created!');
              loadCards();
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to create card');
            } finally {
              setLoading(false);
              setIsCreating(false);
            }
          }
        }
      ]
    );
  };

  const handleToggleFreeze = async (cardId: string) => {
    if (!isOnline) {
      Alert.alert('Offline', 'You need an internet connection to freeze/unfreeze cards');
      return;
    }

    const card = cards.find(c => c.id === cardId);
    const action = card?.status === 'active' ? 'Freeze' : 'Unfreeze';

    Alert.alert(
      `${action} Card`,
      `${action} this virtual card?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: action,
          onPress: async () => {
            try {
              setLoading(true);
              await toggleCardFreeze(auth.token!, cardId);
              loadCards();
            } catch (error: any) {
              Alert.alert('Error', error.message || 'Failed to update card');
            } finally {
              setLoading(false);
            }
          }
        }
      ]
    );
  };

  const handleDelete = async (cardId: string) => {
    Alert.alert('Delete Card', 'Are you sure?', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete', style: 'destructive', onPress: async () => {
          try {
            setLoading(true);
            await deleteVirtualCard(auth.token!, cardId);
            loadCards();
            setSelectedCard(null);
          } catch (error: any) {
            Alert.alert('Error', error.message || 'Failed to delete card');
          } finally {
            setLoading(false);
          }
        }
      }
    ]);
  };

  const maskCardNumber = (number: string) => {
    return `•••• •••• •••• ${number.slice(-4)}`;
  };

  if (selectedCard) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backButton} onPress={() => setSelectedCard(null)}>
          <Ionicons name="arrow-back" size={24} color="#007AFF" />
          <Text style={styles.backText}>Back</Text>
        </TouchableOpacity>

        <View style={styles.cardDisplay}>
          <View style={styles.cardFront}>
            <View style={styles.cardHeader}>
              <Ionicons name="card" size={32} color="#FFFFFF" />
              <Text style={styles.cardBrand}>EGWallet</Text>
            </View>
            <Text style={styles.cardNumber}>{maskCardNumber(selectedCard.cardNumber)}</Text>
            <View style={styles.cardFooter}>
              <View>
                <Text style={styles.cardLabel}>EXPIRES</Text>
                <Text style={styles.cardValue}>{selectedCard.expiryMonth}/{selectedCard.expiryYear}</Text>
              </View>
              <View>
                <Text style={styles.cardLabel}>CVV</Text>
                <Text style={styles.cardValue}>•••</Text>
              </View>
            </View>
          </View>
        </View>

        <View style={styles.cardInfo}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Card Number</Text>
            <Text style={styles.infoValue}>{selectedCard.cardNumber}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>CVV</Text>
            <Text style={styles.infoValue}>{selectedCard.cvv}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Expiry</Text>
            <Text style={styles.infoValue}>{selectedCard.expiryMonth}/{selectedCard.expiryYear}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>Status</Text>
            <Text style={[styles.infoValue, selectedCard.status === 'frozen' && { color: '#d32f2f' }]}>
              {selectedCard.status.toUpperCase()}
            </Text>
          </View>
        </View>

        <TouchableOpacity
          style={styles.freezeButton}
          onPress={() => handleToggleFreeze(selectedCard.id)}
          disabled={loading}
        >
          <Ionicons name={selectedCard.status === 'active' ? 'snow' : 'play'} size={20} color="#007AFF" />
          <Text style={styles.freezeButtonText}>
            {selectedCard.status === 'active' ? 'Freeze Card' : 'Unfreeze Card'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.deleteButton}
          onPress={() => handleDelete(selectedCard.id)}
          disabled={loading}
        >
          <Ionicons name="trash" size={20} color="#d32f2f" />
          <Text style={styles.deleteButtonText}>Delete Card</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <OfflineErrorBanner visible={!isOnline} onRetry={() => {}} />
      <View style={styles.header}>
        <Text style={styles.title}>Virtual Cards</Text>
        {cards.length < 5 && (
          <TouchableOpacity style={styles.addButton} onPress={handleCreateCard} disabled={loading}>
            <Ionicons name="add" size={24} color="#007AFF" />
          </TouchableOpacity>
        )}
      </View>

      {loading && cards.length === 0 ? (
        <View style={styles.cardsList}>
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </View>
      ) : cards.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Ionicons name="card-outline" size={64} color="#CCCCCC" />
          <Text style={styles.emptyTitle}>No Virtual Cards</Text>
          <Text style={styles.emptyText}>Create your first virtual card for online payments</Text>
          <TouchableOpacity style={styles.createFirstButton} onPress={handleCreateCard} disabled={loading}>
            <Ionicons name="add-circle" size={20} color="#FFFFFF" />
            <Text style={styles.createFirstButtonText}>Create Card</Text>
          </TouchableOpacity>
        </View>
      ) : (
        <View style={styles.cardsList}>
          {cards.map((card) => (
            <TouchableOpacity
              key={card.id}
              style={styles.cardItem}
              onPress={() => setSelectedCard(card)}
            >
              <View style={styles.cardMini}>
                <Ionicons name="card" size={24} color="#007AFF" />
                <View style={styles.cardMiniInfo}>
                  <Text style={styles.cardMiniNumber}>{maskCardNumber(card.cardNumber)}</Text>
                  <Text style={styles.cardMiniExpiry}>Exp: {card.expiryMonth}/{card.expiryYear}</Text>
                </View>
              </View>
              <View style={styles.cardMiniStatus}>
                <Text style={[
                  styles.cardMiniStatusText,
                  card.status === 'frozen' && { color: '#d32f2f' }
                ]}>
                  {card.status.toUpperCase()}
                </Text>
                <Ionicons name="chevron-forward" size={20} color="#CCCCCC" />
              </View>
            </TouchableOpacity>
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
    textAlign: 'center',
    paddingHorizontal: 32,
  },
  createFirstButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
    marginTop: 24,
    gap: 8,
  },
  createFirstButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  cardsList: {
    gap: 12,
  },
  cardItem: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 8,
    elevation: 3,
  },
  cardMini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  cardMiniInfo: {},
  cardMiniNumber: {
    fontSize: 16,
    fontWeight: '600',
    color: '#14171A',
    marginBottom: 4,
  },
  cardMiniExpiry: {
    fontSize: 13,
    color: '#657786',
  },
  cardMiniStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  cardMiniStatusText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#2E7D32',
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
  cardDisplay: {
    marginBottom: 24,
  },
  cardFront: {
    height: 200,
    backgroundColor: '#667eea',
    borderRadius: 16,
    padding: 24,
    justifyContent: 'space-between',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 8,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardBrand: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#FFFFFF',
  },
  cardNumber: {
    fontSize: 22,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: 2,
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  cardLabel: {
    fontSize: 10,
    color: 'rgba(255,255,255,0.7)',
    marginBottom: 4,
  },
  cardValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  cardInfo: {
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
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F5F5',
  },
  infoLabel: {
    fontSize: 14,
    color: '#657786',
  },
  infoValue: {
    fontSize: 14,
    fontWeight: '600',
    color: '#14171A',
  },
  freezeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#E8F5FE',
    padding: 16,
    borderRadius: 8,
    marginBottom: 12,
    gap: 8,
  },
  freezeButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#007AFF',
  },
  deleteButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFEBEE',
    padding: 16,
    borderRadius: 8,
    gap: 8,
  },
  deleteButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#d32f2f',
  },
});
