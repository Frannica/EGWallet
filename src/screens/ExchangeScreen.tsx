import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  ActivityIndicator,
  Alert,
  ScrollView,
  Modal,
  FlatList,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { useLanguage } from '../i18n/LanguageContext';
import { listWallets } from '../api/auth';
import { fetchFxQuote, exchangeCurrency, FxQuote } from '../api/transactions';
import {
  majorToMinor,
  formatMinorAmount,
  decimalsFor,
} from '../utils/currency';
import { debitLocalBalance, creditLocalBalance } from '../utils/localBalance';

const POPULAR_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'XAF', 'XOF', 'NGN', 'MAD', 'GHS',
  'KES', 'ZAR', 'CAD', 'JPY', 'CNY', 'SAR', 'AED', 'INR',
  'BRL', 'EGP', 'RWF', 'TND',
];

type Balance = { currency: string; amount: number };

export default function ExchangeScreen({ route, navigation }: any) {
  const { walletId } = route.params || {};
  const auth = useAuth();
  const { t } = useLanguage();

  const [fromCurrency, setFromCurrency] = useState('');
  const [toCurrency, setToCurrency] = useState('USD');
  const [amountStr, setAmountStr] = useState('');
  const [ownedBalances, setOwnedBalances] = useState<Balance[]>([]);
  const [quote, setQuote] = useState<FxQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [showFromPicker, setShowFromPicker] = useState(false);
  const [showToPicker, setShowToPicker] = useState(false);
  const quoteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load wallet balances to populate FROM picker
  useEffect(() => {
    if (!auth.token) return;
    listWallets(auth.token)
      .then(res => {
        const wallet = (res.wallets || []).find((w: any) => w.id === walletId);
        if (!wallet) return;
        const bals: Balance[] = (wallet.balances || []).filter((b: any) => b.amount > 0);
        setOwnedBalances(bals);
        if (bals.length > 0) setFromCurrency(bals[0].currency);
      })
      .catch(() => {});
  }, [auth.token, walletId]);

  // Debounced live quote
  const doFetchQuote = useCallback(() => {
    if (!auth.token || !fromCurrency || !toCurrency || fromCurrency === toCurrency) {
      setQuote(null);
      return;
    }
    const num = parseFloat(amountStr.replace(',', '.'));
    if (!num || num <= 0) { setQuote(null); return; }
    const amountMinor = majorToMinor(num, fromCurrency);
    setQuoteLoading(true);
    fetchFxQuote(auth.token, fromCurrency, toCurrency, amountMinor)
      .then(q => setQuote(q))
      .catch(() => setQuote(null))
      .finally(() => setQuoteLoading(false));
  }, [auth.token, fromCurrency, toCurrency, amountStr]);

  useEffect(() => {
    if (quoteTimer.current) clearTimeout(quoteTimer.current);
    quoteTimer.current = setTimeout(doFetchQuote, 600);
    return () => { if (quoteTimer.current) clearTimeout(quoteTimer.current); };
  }, [doFetchQuote]);

  async function handleExchange() {
    if (submitting) return;
    const num = parseFloat(amountStr.replace(',', '.'));
    if (!num || num <= 0) return;
    if (!fromCurrency || !toCurrency || fromCurrency === toCurrency) return;
    if (!quote) return;

    const amountMinor = majorToMinor(num, fromCurrency);
    const fromBal = ownedBalances.find(b => b.currency === fromCurrency);
    if (!fromBal || fromBal.amount < amountMinor) {
      Alert.alert(t('common.error'), t('exchange.insufficientBalance'));
      return;
    }

    const netReceive = quote.receivedAmountMinorAfterFee ?? quote.receivedAmountMinor ?? 0;
    const netDisplay = formatMinorAmount(netReceive, toCurrency);
    const feeDisplay = formatMinorAmount(quote.fxFeeAmount ?? 0, toCurrency);
    const sendDisplay = num.toFixed(decimalsFor(fromCurrency));

    Alert.alert(
      t('exchange.screenTitle'),
      `${sendDisplay} ${fromCurrency} → ${netDisplay} ${toCurrency}\n\n${quote.rateDisplay}\n${t('exchange.fee')}: ${feeDisplay} ${toCurrency}`,
      [
        { text: t('common.cancel'), style: 'cancel' },
        { text: t('exchange.confirm'), onPress: confirmExchange },
      ]
    );
  }

  async function confirmExchange() {
    if (!auth.token || submitting || !quote) return;
    setSubmitting(true);
    const num = parseFloat(amountStr.replace(',', '.'));
    const amountMinor = majorToMinor(num, fromCurrency);
    const netReceive = quote.receivedAmountMinorAfterFee ?? quote.receivedAmountMinor ?? 0;
    try {
      await exchangeCurrency(auth.token, walletId, fromCurrency, toCurrency, amountMinor);
      await debitLocalBalance(fromCurrency, amountMinor);
      await creditLocalBalance(toCurrency, netReceive);
      Alert.alert(t('common.success'), t('exchange.success'), [
        { text: t('common.ok'), onPress: () => navigation.goBack() },
      ]);
    } catch (err: any) {
      Alert.alert(t('common.error'), err.message || t('common.error'));
    } finally {
      setSubmitting(false);
    }
  }

  const toCurrencies = [...new Set([
    ...POPULAR_CURRENCIES,
    ...ownedBalances.map(b => b.currency),
  ])].filter(c => c !== fromCurrency);

  const fromBal = ownedBalances.find(b => b.currency === fromCurrency);
  const netReceive = quote?.receivedAmountMinorAfterFee ?? quote?.receivedAmountMinor ?? 0;
  const canExchange = !!quote && !quoteLoading && !!fromCurrency && !!toCurrency && fromCurrency !== toCurrency;

  return (
    <ScrollView
      style={styles.container}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      {/* FROM */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t('exchange.youGive')}</Text>
        <TouchableOpacity
          style={styles.currencyRow}
          onPress={() => setShowFromPicker(true)}
          activeOpacity={0.75}
        >
          <Text style={styles.currencyText}>{fromCurrency || '—'}</Text>
          <Ionicons name="chevron-down" size={18} color="#555" />
        </TouchableOpacity>
        {fromBal && (
          <Text style={styles.balanceHint}>
            {t('exchange.balance')}: {formatMinorAmount(fromBal.amount, fromBal.currency)} {fromBal.currency}
          </Text>
        )}
        <TextInput
          style={styles.amountInput}
          placeholder={t('exchange.enterAmount')}
          placeholderTextColor="#B0BEC5"
          keyboardType="decimal-pad"
          value={amountStr}
          onChangeText={v => { setAmountStr(v); setQuote(null); }}
        />
      </View>

      {/* Swap divider */}
      <View style={styles.swapRow}>
        <View style={styles.swapDivider} />
        <View style={styles.swapIconWrap}>
          <Ionicons name="swap-vertical" size={22} color="#1565C0" />
        </View>
        <View style={styles.swapDivider} />
      </View>

      {/* TO */}
      <View style={styles.card}>
        <Text style={styles.cardLabel}>{t('exchange.youGet')}</Text>
        <TouchableOpacity
          style={styles.currencyRow}
          onPress={() => setShowToPicker(true)}
          activeOpacity={0.75}
        >
          <Text style={styles.currencyText}>{toCurrency || '—'}</Text>
          <Ionicons name="chevron-down" size={18} color="#555" />
        </TouchableOpacity>
        {quote && !quoteLoading && (
          <Text style={styles.netReceiveText}>
            ≈ {formatMinorAmount(netReceive, toCurrency)} {toCurrency}
          </Text>
        )}
        {quoteLoading && (
          <ActivityIndicator size="small" color="#1565C0" style={{ marginTop: 10 }} />
        )}
      </View>

      {/* Quote panel */}
      {quote && !quoteLoading && (
        <View style={styles.quoteCard}>
          <QuoteRow label={t('exchange.rate')} value={quote.rateDisplay} />
          <QuoteRow
            label={t('exchange.fee')}
            value={`${formatMinorAmount(quote.fxFeeAmount ?? 0, toCurrency)} ${toCurrency}`}
          />
          <View style={styles.quoteDivider} />
          <QuoteRow
            label={t('exchange.youGet')}
            value={`${formatMinorAmount(netReceive, toCurrency)} ${toCurrency}`}
            bold
          />
        </View>
      )}

      {/* Confirm button */}
      <TouchableOpacity
        style={[styles.btn, !canExchange && styles.btnDisabled]}
        onPress={handleExchange}
        disabled={!canExchange || submitting}
        activeOpacity={0.8}
      >
        {submitting
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.btnText}>{t('exchange.confirm')}</Text>
        }
      </TouchableOpacity>

      {/* FROM picker */}
      <CurrencyPickerModal
        visible={showFromPicker}
        currencies={ownedBalances.map(b => b.currency)}
        selected={fromCurrency}
        title={t('exchange.selectCurrency')}
        onSelect={c => {
          setFromCurrency(c);
          setQuote(null);
          setShowFromPicker(false);
          if (c === toCurrency) {
            const alt = ownedBalances.find(b => b.currency !== c);
            setToCurrency(alt ? alt.currency : 'USD');
          }
        }}
        onClose={() => setShowFromPicker(false)}
      />

      {/* TO picker */}
      <CurrencyPickerModal
        visible={showToPicker}
        currencies={toCurrencies}
        selected={toCurrency}
        title={t('exchange.selectCurrency')}
        onSelect={c => {
          setToCurrency(c);
          setQuote(null);
          setShowToPicker(false);
        }}
        onClose={() => setShowToPicker(false)}
      />
    </ScrollView>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────

function QuoteRow({ label, value, bold = false }: { label: string; value: string; bold?: boolean }) {
  return (
    <View style={styles.quoteRow}>
      <Text style={styles.quoteLabel}>{label}</Text>
      <Text style={[styles.quoteValue, bold && styles.quoteBold]}>{value}</Text>
    </View>
  );
}

function CurrencyPickerModal({
  visible,
  currencies,
  selected,
  title,
  onSelect,
  onClose,
}: {
  visible: boolean;
  currencies: string[];
  selected: string;
  title: string;
  onSelect: (c: string) => void;
  onClose: () => void;
}) {
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <TouchableOpacity style={styles.modalOverlay} onPress={onClose} activeOpacity={1}>
        <View style={styles.modalSheet} onStartShouldSetResponder={() => true}>
          <Text style={styles.modalTitle}>{title}</Text>
          <FlatList
            data={currencies}
            keyExtractor={c => c}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={[styles.currencyItem, item === selected && styles.currencyItemSelected]}
                onPress={() => onSelect(item)}
              >
                <Text style={[styles.currencyItemText, item === selected && styles.currencyItemTextSelected]}>
                  {item}
                </Text>
                {item === selected && <Ionicons name="checkmark" size={18} color="#1565C0" />}
              </TouchableOpacity>
            )}
          />
        </View>
      </TouchableOpacity>
    </Modal>
  );
}

// ── Styles ──────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F9FF',
  },
  content: {
    padding: 16,
    paddingBottom: 40,
  },
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  cardLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: '#9BAEC8',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
    marginBottom: 10,
  },
  currencyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F5F9FF',
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 8,
  },
  currencyText: {
    fontSize: 20,
    fontWeight: '700',
    color: '#1A2B4A',
    letterSpacing: 0.5,
  },
  balanceHint: {
    fontSize: 12,
    color: '#9BAEC8',
    marginBottom: 8,
    marginLeft: 2,
  },
  amountInput: {
    fontSize: 24,
    fontWeight: '600',
    color: '#1A2B4A',
    borderBottomWidth: 2,
    borderBottomColor: '#E3EAF2',
    paddingVertical: 8,
    marginTop: 4,
  },
  netReceiveText: {
    fontSize: 22,
    fontWeight: '700',
    color: '#1565C0',
    marginTop: 6,
    marginLeft: 2,
  },
  swapRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 10,
  },
  swapDivider: {
    flex: 1,
    height: 1,
    backgroundColor: '#E3EAF2',
  },
  swapIconWrap: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#EEF4FF',
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: 12,
  },
  quoteCard: {
    backgroundColor: '#fff',
    borderRadius: 16,
    padding: 16,
    marginTop: 12,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 3,
  },
  quoteRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 6,
  },
  quoteLabel: {
    fontSize: 14,
    color: '#607D9B',
  },
  quoteValue: {
    fontSize: 14,
    color: '#1A2B4A',
    fontWeight: '500',
  },
  quoteBold: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1565C0',
  },
  quoteDivider: {
    height: 1,
    backgroundColor: '#E3EAF2',
    marginVertical: 6,
  },
  btn: {
    marginTop: 24,
    backgroundColor: '#1565C0',
    borderRadius: 14,
    paddingVertical: 16,
    alignItems: 'center',
  },
  btnDisabled: {
    backgroundColor: '#B0C4DE',
  },
  btnText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.45)',
    justifyContent: 'flex-end',
  },
  modalSheet: {
    backgroundColor: '#fff',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    maxHeight: '70%',
  },
  modalTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1A2B4A',
    marginBottom: 14,
    textAlign: 'center',
  },
  currencyItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 14,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F0F4FA',
  },
  currencyItemSelected: {
    backgroundColor: '#EEF4FF',
    borderRadius: 8,
  },
  currencyItemText: {
    fontSize: 16,
    color: '#1A2B4A',
    fontWeight: '500',
  },
  currencyItemTextSelected: {
    color: '#1565C0',
    fontWeight: '700',
  },
});
