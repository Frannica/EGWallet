import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

interface FAQ {
  question: string;
  answer: string;
  category: string;
}

const FAQS: FAQ[] = [
  {
    category: 'Getting Started',
    question: 'How do I create a wallet?',
    answer: 'Your wallet is automatically created when you register. You can view your wallet balance on the home screen.',
  },
  {
    category: 'Getting Started',
    question: 'Is my money safe?',
    answer: 'Yes! We use bank-level encryption and security. Your funds are protected with biometric authentication and all transactions are encrypted.',
  },
  {
    category: 'Sending Money',
    question: 'How do I send money?',
    answer: 'Tap the "Send" button on your wallet screen, enter the recipient\'s wallet ID or scan their QR code, enter the amount, and confirm.',
  },
  {
    category: 'Sending Money',
    question: 'What are the sending limits?',
    answer: 'You can send up to $5,000 USD per day. Your wallet can hold up to $250,000 USD equivalent.',
  },
  {
    category: 'Payment Requests',
    question: 'How do payment requests work?',
    answer: 'Create a payment request with an amount and share the link. When someone pays it, the money goes directly to your wallet.',
  },
  {
    category: 'Payment Requests',
    question: 'Can I cancel a payment request?',
    answer: 'Yes, you can cancel any pending payment request. Once paid, it cannot be cancelled.',
  },
  {
    category: 'Virtual Cards',
    question: 'What are virtual cards?',
    answer: 'Virtual cards are temporary card numbers you can use for online shopping. They help protect your main wallet from fraud.',
  },
  {
    category: 'Virtual Cards',
    question: 'Are virtual cards free?',
    answer: 'Yes, you can create up to 5 virtual cards for free. Each card has a daily spending limit of $1,000 USD.',
  },
  {
    category: 'Budgets',
    question: 'How do budgets help me?',
    answer: 'Budgets help you track spending by category. Set monthly limits and get alerts when you\'re close to your limit.',
  },
  {
    category: 'Currency',
    question: 'Can I receive money in different currencies?',
    answer: 'Yes! You can receive 30+ currencies. Enable auto-convert in settings to automatically convert to your preferred currency.',
  },
  {
    category: 'Security',
    question: 'How do I enable biometric lock?',
    answer: 'Go to Settings > Privacy & Security and toggle on Fingerprint/Face Lock. Your app will be locked when you leave it.',
  },
  {
    category: 'Account',
    question: 'How do I delete my account?',
    answer: 'Go to Settings > Privacy & Security > Delete Account. You\'ll need to contact support to verify your identity.',
  },
];

const CATEGORIES = Array.from(new Set(FAQS.map(f => f.category)));

export default function HelpCenterScreen() {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const filteredFAQs = selectedCategory
    ? FAQS.filter(f => f.category === selectedCategory)
    : FAQS;

  const handleContactSupport = () => {
    Linking.openURL('mailto:support@egwallet.com?subject=Help Request');
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="help-circle" size={48} color="#007AFF" />
        <Text style={styles.title}>Help Center</Text>
        <Text style={styles.subtitle}>
          Find answers to common questions or contact our support team
        </Text>
      </View>

      {/* Contact Support Button */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.supportButton} onPress={handleContactSupport}>
          <Ionicons name="mail" size={24} color="#FFFFFF" />
          <Text style={styles.supportButtonText}>Contact Support</Text>
        </TouchableOpacity>
      </View>

      {/* Category Filter */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Browse by Category</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.categoryScroll}>
          <TouchableOpacity
            style={[styles.categoryChip, !selectedCategory && styles.categoryChipActive]}
            onPress={() => setSelectedCategory(null)}
          >
            <Text style={[styles.categoryChipText, !selectedCategory && styles.categoryChipTextActive]}>
              All
            </Text>
          </TouchableOpacity>
          {CATEGORIES.map((category) => (
            <TouchableOpacity
              key={category}
              style={[styles.categoryChip, selectedCategory === category && styles.categoryChipActive]}
              onPress={() => setSelectedCategory(category)}
            >
              <Text style={[styles.categoryChipText, selectedCategory === category && styles.categoryChipTextActive]}>
                {category}
              </Text>
            </TouchableOpacity>
          ))}
        </ScrollView>
      </View>

      {/* FAQs */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Frequently Asked Questions</Text>
        {filteredFAQs.map((faq, index) => (
          <View key={index} style={styles.faqCard}>
            <TouchableOpacity
              onPress={() => setExpandedIndex(expandedIndex === index ? null : index)}
              style={styles.faqHeader}
            >
              <View style={styles.faqQuestionContainer}>
                <Text style={styles.faqCategory}>{faq.category}</Text>
                <Text style={styles.faqQuestion}>{faq.question}</Text>
              </View>
              <Ionicons
                name={expandedIndex === index ? 'chevron-up' : 'chevron-down'}
                size={24}
                color="#007AFF"
              />
            </TouchableOpacity>
            {expandedIndex === index && (
              <View style={styles.faqAnswer}>
                <Text style={styles.faqAnswerText}>{faq.answer}</Text>
              </View>
            )}
          </View>
        ))}
      </View>

      {/* Bottom CTA */}
      <View style={styles.bottomSection}>
        <Text style={styles.bottomText}>Still need help?</Text>
        <TouchableOpacity style={styles.bottomButton} onPress={handleContactSupport}>
          <Text style={styles.bottomButtonText}>Email Our Support Team</Text>
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
