import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useLanguage } from '../i18n/LanguageContext';

interface FAQ {
  categoryKey: string;
  questionKey: string;
  answerKey: string;
}

const FAQS: FAQ[] = [
  {
    categoryKey: 'help.category.gettingStarted',
    questionKey: 'help.question.createWallet',
    answerKey: 'help.answer.createWallet',
  },
  {
    categoryKey: 'help.category.gettingStarted',
    questionKey: 'help.question.moneySafe',
    answerKey: 'help.answer.moneySafe',
  },
  {
    categoryKey: 'help.category.sendingMoney',
    questionKey: 'help.question.sendMoney',
    answerKey: 'help.answer.sendMoney',
  },
  {
    categoryKey: 'help.category.sendingMoney',
    questionKey: 'help.question.sendingLimits',
    answerKey: 'help.answer.sendingLimits',
  },
  {
    categoryKey: 'help.category.paymentRequests',
    questionKey: 'help.question.paymentRequestsWork',
    answerKey: 'help.answer.paymentRequestsWork',
  },
  {
    categoryKey: 'help.category.paymentRequests',
    questionKey: 'help.question.cancelPaymentRequest',
    answerKey: 'help.answer.cancelPaymentRequest',
  },
  {
    categoryKey: 'help.category.virtualCards',
    questionKey: 'help.question.virtualCards',
    answerKey: 'help.answer.virtualCards',
  },
  {
    categoryKey: 'help.category.virtualCards',
    questionKey: 'help.question.virtualCardsFree',
    answerKey: 'help.answer.virtualCardsFree',
  },
  {
    categoryKey: 'help.category.budgets',
    questionKey: 'help.question.budgetsHelp',
    answerKey: 'help.answer.budgetsHelp',
  },
  {
    categoryKey: 'help.category.currency',
    questionKey: 'help.question.receiveDifferentCurrencies',
    answerKey: 'help.answer.receiveDifferentCurrencies',
  },
  {
    categoryKey: 'help.category.security',
    questionKey: 'help.question.enableBiometricLock',
    answerKey: 'help.answer.enableBiometricLock',
  },
  {
    categoryKey: 'help.category.account',
    questionKey: 'help.question.deleteAccount',
    answerKey: 'help.answer.deleteAccount',
  },
];

const CATEGORIES = Array.from(new Set(FAQS.map(f => f.categoryKey)));

export default function HelpCenterScreen() {
  const { t } = useLanguage();
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const filteredFAQs = selectedCategory
    ? FAQS.filter(f => f.categoryKey === selectedCategory)
    : FAQS;

  const handleContactSupport = () => {
    Linking.openURL('mailto:support@egwalletfinance.com?subject=Help Request');
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="help-circle" size={48} color="#007AFF" />
        <Text style={styles.title}>{t('help.title')}</Text>
        <Text style={styles.subtitle}>
          {t('help.subtitle')}
        </Text>
      </View>

      {/* Contact Support Button */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.supportButton} onPress={handleContactSupport}>
          <Ionicons name="mail" size={24} color="#FFFFFF" />
          <Text style={styles.supportButtonText}>{t('help.contactSupport')}</Text>
        </TouchableOpacity>
      </View>

      {/* Category Filter */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('help.browseByCategory')}</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
          <TouchableOpacity
            style={[styles.categoryChip, !selectedCategory && styles.categoryChipActive]}
            onPress={() => setSelectedCategory(null)}
          >
            <Text style={[styles.categoryChipText, !selectedCategory && styles.categoryChipTextActive]} numberOfLines={1}>
              {t('help.all')}
            </Text>
          </TouchableOpacity>
          {CATEGORIES.map((category) => (
            <TouchableOpacity
              key={category}
              style={[styles.categoryChip, selectedCategory === category && styles.categoryChipActive]}
              onPress={() => setSelectedCategory(category)}
            >
              <Text style={[styles.categoryChipText, selectedCategory === category && styles.categoryChipTextActive]} numberOfLines={1}>
                {t(category)}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* FAQs */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('help.faqs')}</Text>
        {filteredFAQs.map((faq, index) => (
          <View key={index} style={styles.faqCard}>
            <TouchableOpacity
              onPress={() => setExpandedIndex(expandedIndex === index ? null : index)}
              style={styles.faqHeader}
            >
              <View style={styles.faqQuestionContainer}>
                <Text style={styles.faqCategory}>{t(faq.categoryKey)}</Text>
                <Text style={styles.faqQuestion}>{t(faq.questionKey)}</Text>
              </View>
              <Ionicons
                name={expandedIndex === index ? 'chevron-up' : 'chevron-down'}
                size={24}
                color="#007AFF"
              />
            </TouchableOpacity>
            {expandedIndex === index && (
              <View style={styles.faqAnswer}>
                <Text style={styles.faqAnswerText}>{t(faq.answerKey)}</Text>
              </View>
            )}
          </View>
        ))}
      </View>

      {/* Bottom CTA */}
      <View style={styles.bottomSection}>
        <Text style={styles.bottomText}>{t('help.stillNeedHelp')}</Text>
        <TouchableOpacity style={styles.bottomButton} onPress={handleContactSupport}>
          <Text style={styles.bottomButtonText}>{t('help.emailSupport')}</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  header: {
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#1C1E21',
    marginTop: 12,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#657786',
    textAlign: 'center',
    lineHeight: 20,
    paddingHorizontal: 20,
  },
  section: {
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1C1E21',
    marginBottom: 12,
  },
  supportButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
    paddingVertical: 14,
    borderRadius: 12,
    gap: 10,
  },
  supportButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  categoryScroll: {
    marginBottom: 8,
  },
  categoryChip: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: '#FFFFFF',
    borderRadius: 20,
    marginRight: 8,
    borderWidth: 1,
    borderColor: '#E1E8ED',
    maxWidth: 200,
  },
  categoryChipActive: {
    backgroundColor: '#007AFF',
    borderColor: '#007AFF',
  },
  categoryChipText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#657786',
  },
  categoryChipTextActive: {
    color: '#FFFFFF',
  },
  faqCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    marginBottom: 12,
    overflow: 'hidden',
  },
  faqHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 16,
  },
  faqQuestionContainer: {
    flex: 1,
    marginRight: 12,
  },
  faqCategory: {
    fontSize: 11,
    fontWeight: '600',
    color: '#007AFF',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  faqQuestion: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1E21',
    lineHeight: 22,
  },
  faqAnswer: {
    padding: 16,
    paddingTop: 0,
    borderTopWidth: 1,
    borderTopColor: '#F5F8FA',
  },
  faqAnswerText: {
    fontSize: 14,
    color: '#657786',
    lineHeight: 20,
  },
  bottomSection: {
    alignItems: 'center',
    padding: 24,
    marginTop: 16,
  },
  bottomText: {
    fontSize: 16,
    color: '#657786',
    marginBottom: 12,
  },
  bottomButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: '#F0F7FF',
    borderRadius: 8,
  },
  bottomButtonText: {
    fontSize: 14,
    fontWeight: '600',
    color: '#007AFF',
  },
});

