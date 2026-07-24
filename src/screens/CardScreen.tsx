import React, { useState, useEffect, useRef } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Animated } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { createVirtualCard, getVirtualCards, toggleCardFreeze, deleteVirtualCard } from '../api/transactions';
import { listWallets } from '../api/auth';
import { useFocusEffect } from '@react-navigation/native';
import { OfflineErrorBanner, useNetworkStatus } from '../utils/OfflineError';
import { useLanguage } from '../i18n/LanguageContext';
import { getApiErrorMessage } from '../utils/apiErrorMessage';
import { CardSkeleton } from '../components/SkeletonLoader';
import { useToast } from '../utils/toast';
import { formatCardExpiry, formatMaskedCardNumber } from '../utils/virtualCardDisplay';
import { formatStatusLabel } from '../utils/safeDisplay';

interface VirtualCard {
  id: string;
  cardNumber?: string;
  last4?: string;
  maskedNumber?: string;
  cvv?: string;
  expiryMonth: string;
  expiryYear: string;
  currency: string;
  label: string;
  status: 'active' | 'frozen';
}

function normalizeCardFromApi(raw: any, defaultLabel: string): VirtualCard {
  return {
    id: String(raw?.id ?? ''),
    cardNumber: raw?.cardNumber,
    last4: raw?.last4,
    maskedNumber: raw?.maskedNumber,
    cvv: raw?.cvv,
    expiryMonth: raw?.expiryMonth ?? '--',
    expiryYear: raw?.expiryYear ?? '--',
    currency: raw?.currency ?? 'USD',
    label: raw?.label ?? defaultLabel,
    status: raw?.status === 'frozen' ? 'frozen' : 'active',
  };
}

export default function CardScreen() {
  const auth = useAuth();
  const { t } = useLanguage();
  const { isOnline } = useNetworkStatus();
  const toast = useToast();
  const [loading, setLoading] = useState(false);
  const [cards, setCards] = useState<VirtualCard[]>([]);
  const [selectedCard, setSelectedCard] = useState<VirtualCard | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [wallets, setWallets] = useState<any[]>([]);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(fadeAnim, { toValue: 1, duration: 500, useNativeDriver: true }).start();
  }, []);

  useEffect(() => {
    loadWallets();
  }, []);

  useFocusEffect(
    React.useCallback(() => {
      loadCards();
    }, [])
  );

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
    if (!auth.token) return;
    try {
      setLoading(true);
      const data = await getVirtualCards(auth.token);
      setCards(
        (data.cards || [])
          .map((raw: any) => normalizeCardFromApi(raw, t('card.defaultLabel')))
          .filter((c: VirtualCard) => c.id)
      );
    } catch (error: any) {
      setCards([]);
      Alert.alert(t('common.error'), getApiErrorMessage(error, t));
    } finally {
      setLoading(false);
    }
  };

  const handleCreateCard = async () => {
    if (__DEV__) console.log('[Card] Create Card button pressed');
    if (isCreating) return;

    Alert.alert(
      t('card.createVirtualCardTitle'),
      t('card.createVirtualCardMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('card.createAction'),
          onPress: async () => {
            try {
              if (!auth.token) return;
              setIsCreating(true);
              setLoading(true);
              const walletId = wallets[0]?.id || 'demo';
              await createVirtualCard(auth.token!, walletId, 'USD', t('card.defaultLabel'));
              if (__DEV__) console.log('[Card] Created via API');
              toast.show(t('card.cardCreated'));
              loadCards();
            } catch (error: any) {
              Alert.alert(t('common.error'), getApiErrorMessage(error, t));
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
    const card = cards.find(c => c.id === cardId);
    const isFreezing = card?.status === 'active';

    Alert.alert(
      isFreezing ? t('card.freeze') : t('card.unfreeze'),
      isFreezing ? t('card.freezeConfirmMsg') : t('card.unfreezeConfirmMsg'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: isFreezing ? t('card.freeze') : t('card.unfreeze'),
          onPress: async () => {
            try {
              if (!auth.token) return;
              setLoading(true);
              await toggleCardFreeze(auth.token!, cardId);
              loadCards();
            } catch (error: any) {
              Alert.alert(t('common.error'), getApiErrorMessage(error, t));
            } finally {
              setLoading(false);
            }
          }
        }
      ]
    );
  };

  const handleDelete = async (cardId: string) => {
    Alert.alert(t('card.deleteCard'), t('common.areYouSure'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('common.delete'), style: 'destructive', onPress: async () => {
          try {
            if (!auth.token) return;
            setLoading(true);
            await deleteVirtualCard(auth.token!, cardId);
            loadCards();
            setSelectedCard(null);
          } catch (error: any) {
            Alert.alert(t('common.error'), getApiErrorMessage(error, t));
          } finally {
            setLoading(false);
          }
        }
      }
    ]);
  };

  if (selectedCard) {
    return (
      <Animated.ScrollView style={[styles.container, { opacity: fadeAnim }]} contentContainerStyle={styles.content}>
        <TouchableOpacity style={styles.backButton} onPress={() => setSelectedCard(null)} activeOpacity={0.75}>
          <View style={styles.backIconWrap}>
            <Ionicons name="arrow-back" size={20} color="#1565C0" />
          </View>
          <Text style={styles.backText}>{t('card.title')}</Text>
        </TouchableOpacity>

        <View style={styles.cardDisplay}>
          <LinearGradient
            colors={['#0A3D7C', '#1565C0', '#2196F3']}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 1 }}
            style={styles.cardFront}
          >
            <View style={styles.cardShine} />
            <View style={styles.cardShine2} />
            <View style={styles.cardHeader}>
              <Ionicons name="card" size={28} color="rgba(255,255,255,0.9)" />
              <Text style={styles.cardBrand}>EGWallet</Text>
            </View>
            <Text style={styles.cardNumber}>{formatMaskedCardNumber(selectedCard)}</Text>
            <View style={styles.cardFooter}>
              <View>
                <Text style={styles.cardLabel}>{formatStatusLabel(t('card.expires'), 'expires')}</Text>
                <Text style={styles.cardValue}>{formatCardExpiry(selectedCard.expiryMonth, selectedCard.expiryYear)}</Text>
              </View>
              <View>
                <Text style={styles.cardLabel}>{formatStatusLabel(t('card.cvv'), 'cvv')}</Text>
                <Text style={styles.cardValue}>***</Text>
              </View>
              <View style={styles.visaBadge}>
                <Text style={styles.visaText}>VISA</Text>
              </View>
            </View>
          </LinearGradient>
        </View>

        <View style={styles.cardInfo}>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{t('card.number')}</Text>
            <Text style={styles.infoValue}>{formatMaskedCardNumber(selectedCard)}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{t('card.cvv')}</Text>
            <Text style={styles.infoValue}>{'***'}</Text>
          </View>
          <View style={styles.infoRow}>
            <Text style={styles.infoLabel}>{t('card.expiry')}</Text>
            <Text style={styles.infoValue}>{formatCardExpiry(selectedCard.expiryMonth, selectedCard.expiryYear)}</Text>
          </View>
          <View style={[styles.infoRow, { borderBottomWidth: 0 }]}>
            <Text style={styles.infoLabel}>{t('card.status')}</Text>
            <View style={selectedCard.status === 'frozen' ? styles.frozenBadge : styles.activeBadge}>
              <View style={selectedCard.status === 'frozen' ? styles.frozenDot : styles.activeDot} />
              <Text style={selectedCard.status === 'frozen' ? styles.frozenText : styles.activeText}>
              {selectedCard.status === 'frozen' ? t('card.frozen') : t('card.active')}
              </Text>
            </View>
          </View>
        </View>

        <TouchableOpacity
          style={[styles.actionBtn, selectedCard.status === 'active' ? styles.freezeBtn : styles.unfreezeBtn]}
          onPress={() => handleToggleFreeze(selectedCard.id)}
          disabled={loading}
          activeOpacity={0.75}
        >
          <Ionicons name={selectedCard.status === 'active' ? 'snow' : 'play-circle'} size={20} color={selectedCard.status === 'active' ? '#1565C0' : '#00897B'} />
          <Text style={[styles.actionBtnText, { color: selectedCard.status === 'active' ? '#1565C0' : '#00897B' }]}>
            {selectedCard.status === 'active' ? t('card.freeze') : t('card.unfreeze')}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.actionBtn, styles.deleteBtn]}
          onPress={() => handleDelete(selectedCard.id)}
          disabled={loading}
          activeOpacity={0.75}
        >
          <Ionicons name="trash" size={20} color="#DC2626" />
          <Text style={[styles.actionBtnText, { color: '#DC2626' }]}>{t('card.deleteCard')}</Text>
        </TouchableOpacity>
      </Animated.ScrollView>
    );
  }

  // Virtual card issuance requires a real card-network integration (Stripe
  // Issuing cardholder + funded Issuing balance + real-time authorization).
  // That integration is not wired up yet, so any "card" this screen could
  // create would be a non-functional, unspendable fake — never present that
  // as a real production feature. Existing cards (if any were provisioned in
  // a prior test/dev configuration) still render read-only below; new
  // creation is disabled everywhere.
  const virtualCardsAvailable = false;

  if (!virtualCardsAvailable && cards.length === 0) {
    return (
      <Animated.ScrollView style={[styles.container, { opacity: fadeAnim }]} contentContainerStyle={styles.content}>
        <OfflineErrorBanner visible={!isOnline} onRetry={() => { loadCards(); loadWallets(); }} />
        <View style={styles.header}>
          <Text style={styles.title}>{t('card.title')}</Text>
        </View>
        {loading ? (
          <View style={styles.cardsList}>
            <CardSkeleton />
          </View>
        ) : (
          <View style={styles.emptyContainer}>
            <View style={styles.emptyIconBg}>
              <Ionicons name="time-outline" size={40} color="#1565C0" />
            </View>
            <Text style={styles.emptyTitle}>{t('card.notAvailable')}</Text>
            <Text style={styles.emptyText}>{t('card.notAvailableDesc')}</Text>
          </View>
        )}
      </Animated.ScrollView>
    );
  }

  return (
    <Animated.ScrollView style={[styles.container, { opacity: fadeAnim }]} contentContainerStyle={styles.content}>
      <OfflineErrorBanner visible={!isOnline} onRetry={() => { loadCards(); loadWallets(); }} />
      <View style={styles.header}>
        <Text style={styles.title}>{t('card.title')}</Text>
      </View>

      {loading && cards.length === 0 ? (
        <View style={styles.cardsList}>
          <CardSkeleton />
          <CardSkeleton />
          <CardSkeleton />
        </View>
      ) : cards.length === 0 ? (
        <View style={styles.emptyContainer}>
          <View style={styles.emptyIconBg}>
            <Ionicons name="card-outline" size={40} color="#1565C0" />
          </View>
          <Text style={styles.emptyTitle}>{t('card.noCards')}</Text>
          <Text style={styles.emptyText}>{t('card.noCardsDesc')}</Text>
        </View>
      ) : (
        <View style={styles.cardsList}>
          {cards.map((card) => (
            <TouchableOpacity
              key={card.id}
              style={styles.cardItem}
              onPress={() => setSelectedCard(card)}
              activeOpacity={0.8}
            >
              <LinearGradient
                colors={card.status === 'frozen' ? ['#546E7A', '#78909C'] : ['#1565C0', '#1976D2']}
                start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }}
                style={styles.cardMiniGradient}
              />
              <View style={styles.cardMini}>
                <Ionicons name="card" size={22} color="#1565C0" />
                <View style={styles.cardMiniInfo}>
                  <Text style={styles.cardMiniNumber}>{formatMaskedCardNumber(card)}</Text>
                  <Text style={styles.cardMiniExpiry}>{t('card.expires')} {formatCardExpiry(card.expiryMonth, card.expiryYear)}</Text>
                </View>
              </View>
              <View style={styles.cardMiniStatus}>
                <View style={card.status === 'frozen' ? styles.frozenBadge : styles.activeBadge}>
                  <Text style={card.status === 'frozen' ? styles.frozenText : styles.activeText}>
                    {card.status === 'frozen' ? t('card.frozen') : t('card.active')}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={18} color="#9BAAB8" />
              </View>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </Animated.ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#EBF4FE',
  },
  content: {
    padding: 20,
    paddingTop: 8,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 24,
    marginTop: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '800',
    color: '#0D1B2E',
    letterSpacing: -0.5,
  },
  addButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
    elevation: 3,
  },
  cardLimitBadge: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 10,
    backgroundColor: '#F1F5F9',
  },
  cardLimitText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#9BAAB8',
  },

  // Premium Card Display
  cardDisplay: {
    marginBottom: 24,
  },
  cardFront: {
    height: 220,
    borderRadius: 22,
    padding: 26,
    justifyContent: 'space-between',
    overflow: 'hidden',
    shadowColor: '#0A3D7C',
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.45,
    shadowRadius: 22,
    elevation: 14,
  },
  cardShine: {
    position: 'absolute',
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: 'rgba(255,255,255,0.08)',
    top: -60,
    right: -40,
  },
  cardShine2: {
    position: 'absolute',
    width: 130,
    height: 130,
    borderRadius: 65,
    backgroundColor: 'rgba(255,255,255,0.05)',
    bottom: -40,
    left: 20,
  },
  cardHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  cardBrand: {
    fontSize: 17,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 0.5,
  },
  cardNumber: {
    fontSize: 21,
    fontWeight: '600',
    color: '#FFFFFF',
    letterSpacing: 3,
    textAlign: 'center',
  },
  cardFooter: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-end',
  },
  cardLabel: {
    fontSize: 9,
    color: 'rgba(255,255,255,0.65)',
    marginBottom: 3,
    letterSpacing: 1,
    fontWeight: '600',
  },
  cardValue: {
    fontSize: 14,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  visaBadge: {
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 6,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
  },
  visaText: {
    fontSize: 13,
    fontWeight: '800',
    color: '#FFFFFF',
    letterSpacing: 1,
  },

  // Card Info
  cardInfo: {
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 18,
    marginBottom: 14,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.07,
    shadowRadius: 12,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.07)',
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(21,101,192,0.06)',
  },
  infoLabel: {
    fontSize: 13,
    color: '#5C6E8A',
  },
  infoValue: {
    fontSize: 13,
    fontWeight: '600',
    color: '#0D1B2E',
  },

  // Status Badges
  activeBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#DCFCE7',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 5,
  },
  activeDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#00C853',
  },
  activeText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#15803D',
  },
  frozenBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#E0F0FF',
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 20,
    gap: 5,
  },
  frozenDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#546E7A',
  },
  frozenText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#37474F',
  },

  // Action Buttons
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    borderRadius: 16,
    marginBottom: 12,
    gap: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.05,
    shadowRadius: 8,
    elevation: 2,
  },
  freezeBtn: {
    backgroundColor: '#DBEAFE',
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.12)',
  },
  unfreezeBtn: {
    backgroundColor: '#E0F2F1',
    borderWidth: 1,
    borderColor: 'rgba(0,137,123,0.12)',
  },
  deleteBtn: {
    backgroundColor: '#FEF2F2',
    borderWidth: 1,
    borderColor: 'rgba(220,38,38,0.12)',
  },
  actionBtnText: {
    fontSize: 15,
    fontWeight: '700',
  },

  // Back Button
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    gap: 10,
  },
  backIconWrap: {
    width: 36,
    height: 36,
    borderRadius: 11,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
  },
  backText: {
    fontSize: 16,
    fontWeight: '700',
    color: '#0D1B2E',
  },

  // Empty State
  emptyContainer: {
    paddingVertical: 64,
    alignItems: 'center',
  },
  emptyIconBg: {
    width: 88,
    height: 88,
    borderRadius: 26,
    backgroundColor: '#DBEAFE',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 20,
  },
  emptyTitle: {
    fontSize: 20,
    fontWeight: '700',
    color: '#0D1B2E',
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    color: '#5C6E8A',
    textAlign: 'center',
    paddingHorizontal: 32,
    lineHeight: 20,
    marginBottom: 28,
  },
  createFirstButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#1565C0',
    paddingHorizontal: 28,
    paddingVertical: 14,
    borderRadius: 16,
    gap: 8,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.3,
    shadowRadius: 10,
    elevation: 6,
  },
  createFirstButtonText: {
    fontSize: 15,
    fontWeight: '700',
    color: '#FFFFFF',
  },

  // Card List
  cardsList: {
    gap: 12,
  },
  cardItem: {
    backgroundColor: 'rgba(255,255,255,0.93)',
    borderRadius: 18,
    padding: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.08,
    shadowRadius: 12,
    elevation: 3,
    borderWidth: 1,
    borderColor: 'rgba(21,101,192,0.07)',
    overflow: 'hidden',
  },
  cardMiniGradient: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: 5,
    borderTopLeftRadius: 18,
    borderBottomLeftRadius: 18,
  },
  cardMini: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 8,
  },
  cardMiniInfo: {},
  cardMiniNumber: {
    fontSize: 15,
    fontWeight: '700',
    color: '#0D1B2E',
    marginBottom: 3,
  },
  cardMiniExpiry: {
    fontSize: 12,
    color: '#5C6E8A',
  },
  cardMiniStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },

  loadingContainer: {
    paddingVertical: 64,
    alignItems: 'center',
  },
});

