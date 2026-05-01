import React from 'react';
import { View, Text } from 'react-native';
import { getRegionalConfig } from '../config/regional';
import { FEE_SCHEDULE } from '../config/fees';
import { useLanguage } from '../i18n/LanguageContext';

interface KYCDisclosureProps {
  region: 'GQ' | 'AF' | 'EU' | 'OTHER';
}

/**
 * KYC & Limits Disclosure
 * Shows local regulatory requirements and limits in user's currency
 */
export function KYCDisclosure({ region }: KYCDisclosureProps) {
  const config = getRegionalConfig(region);
  const { t } = useLanguage();

  return (
    <View style={{ backgroundColor: '#f5f5f5' }}>
      <View style={{ padding: 16 }}>
        {/* Daily Limits */}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#007AFF' }}>
            {t('kyc.dailyLimitsTitle')}
          </Text>
          <View style={{ backgroundColor: '#f0f7ff', padding: 12, borderRadius: 6, marginBottom: 12 }}>
            <Text style={{ color: '#00539b', fontWeight: '600', fontSize: 14 }}>
            {t('kyc.dailySendingLimit')}: ${config.daily_limit_usd.toLocaleString()} USD
            </Text>
            <Text style={{ color: '#00539b', fontSize: 12, marginTop: 4 }}>
              (~{Math.round(config.daily_limit_usd * 600).toLocaleString()} {config.currency})
            </Text>
          </View>
          <Text style={{ color: '#666', fontSize: 13 }}>
            {t('kyc.dailyLimitDesc')}
          </Text>
        </View>

        {/* Wallet Capacity */}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#007AFF' }}>
            {t('kyc.walletCapacityTitle')}
          </Text>
          <View style={{ backgroundColor: '#f0f7ff', padding: 12, borderRadius: 6, marginBottom: 12 }}>
            <Text style={{ color: '#00539b', fontWeight: '600', fontSize: 14 }}>
            {t('kyc.maxBalance')}
            </Text>
            <Text style={{ color: '#00539b', fontSize: 12, marginTop: 4 }}>
              (~150,000,000 {config.currency})
            </Text>
          </View>
          <Text style={{ color: '#666', fontSize: 13 }}>
            {t('kyc.walletCapacityDesc')}
          </Text>
        </View>

        {/* Fees Section */}
        <View style={{ backgroundColor: '#fff', borderRadius: 8, padding: 16, marginBottom: 16 }}>
          <Text style={{ fontSize: 16, fontWeight: '600', marginBottom: 12, color: '#007AFF' }}>
            {t('kyc.feesTitle')}
          </Text>
          {FEE_SCHEDULE.map((item) => (
            <View
              key={item.type}
              style={{ flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 8, borderBottomWidth: 1, borderBottomColor: '#f0f0f0' }}
            >
              <View style={{ flex: 1 }}>
                <Text style={{ fontSize: 14, color: '#333', fontWeight: '500' }}>{item.type}</Text>
                {item.note ? (
                  <Text style={{ fontSize: 12, color: '#999', marginTop: 2 }}>{item.note}</Text>
                ) : null}
              </View>
              <Text style={{ fontSize: 14, fontWeight: '700', color: item.fee === 'Free' ? '#2E7D32' : '#1565C0', marginLeft: 12 }}>
                {item.fee}
              </Text>
            </View>
          ))}
          <Text style={{ color: '#999', fontSize: 12, marginTop: 12, fontStyle: 'italic' }}>
            {t('kyc.feesDisclaimer')}
          </Text>
        </View>

        {/* Regional Info */}
        <View style={{ backgroundColor: '#f5f5f5', borderRadius: 8, padding: 16, borderLeftWidth: 4, borderLeftColor: '#007AFF' }}>
          <Text style={{ fontSize: 14, fontWeight: '600', marginBottom: 8, color: '#333' }}>
            {t('kyc.regionalInfoTitle')}
          </Text>
          <Text style={{ color: '#666', fontSize: 13, marginBottom: 4 }}>
            {t('kyc.regionLabel')} {region === 'GQ' ? `🇬🇶 ${t('kyc.regionGQ')}` : region === 'AF' ? `🌍 ${t('kyc.regionAF')}` : `🌎 ${t('kyc.regionGlobal')}`}
          </Text>
          <Text style={{ color: '#666', fontSize: 13 }}>
            {t('kyc.primaryCurrency')} {config.currency}
          </Text>
        </View>
      </View>
    </View>
  );
}
