import React, { useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TextInput, TouchableOpacity, Alert, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';

type ProblemCategory = 'bug' | 'payment' | 'account' | 'feature' | 'other';

export default function ReportProblemScreen() {
  const auth = useAuth();
  const [category, setCategory] = useState<ProblemCategory>('bug');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const categories: { value: ProblemCategory; label: string; icon: string }[] = [
    { value: 'bug', label: 'Bug Report', icon: 'bug' },
    { value: 'payment', label: 'Payment Issue', icon: 'cash' },
    { value: 'account', label: 'Account Problem', icon: 'person-circle' },
    { value: 'feature', label: 'Feature Request', icon: 'bulb' },
    { value: 'other', label: 'Other', icon: 'ellipsis-horizontal' },
  ];

  const handleSubmit = async () => {
    if (!title.trim()) {
      Alert.alert('Error', 'Please enter a title');
      return;
    }

    if (!description.trim()) {
      Alert.alert('Error', 'Please describe the problem');
      return;
    }

    setIsSubmitting(true);

    try {
      // In a real app, this would send to your backend
      // For now, we'll just email support
      const subject = `[${category.toUpperCase()}] ${title}`;
      const body = `
Category: ${categories.find(c => c.value === category)?.label}
User: ${auth.user?.email}

Description:
${description}

---
Submitted via EGWallet mobile app
      `.trim();

      // Simulate API delay
      await new Promise(resolve => setTimeout(resolve, 1000));

      Alert.alert(
        'Report Submitted',
        'Thank you for your feedback! Our support team will review your report and get back to you within 24-48 hours.',
        [
          {
            text: 'OK',
            onPress: () => {
              setTitle('');
              setDescription('');
              setCategory('bug');
            },
          },
        ]
      );

      // In production, you would send this to your backend:
      // await fetch(`${API_BASE}/support/report`, {
      //   method: 'POST',
      //   headers: {
      //     'Content-Type': 'application/json',
      //     'Authorization': `Bearer ${auth.token}`,
      //   },
      //   body: JSON.stringify({
      //     category,
      //     title,
      //     description,
      //     userEmail: auth.user?.email,
      //   }),
      // });

    } catch (error: any) {
      Alert.alert('Error', 'Failed to submit report. Please try again or email support@egwallet.com directly.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="alert-circle" size={48} color="#007AFF" />
        <Text style={styles.title}>Report a Problem</Text>
        <Text style={styles.subtitle}>
          Help us improve by reporting bugs or suggesting features
        </Text>
      </View>

      <View style={styles.form}>
        {/* Category Selection */}
        <View style={styles.section}>
          <Text style={styles.label}>Category</Text>
          <View style={styles.categoryGrid}>
            {categories.map((cat) => (
              <TouchableOpacity
                key={cat.value}
                style={[
                  styles.categoryOption,
                  category === cat.value && styles.categoryOptionSelected,
                ]}
                onPress={() => setCategory(cat.value)}
              >
                <Ionicons
                  name={cat.icon as any}
                  size={24}
                  color={category === cat.value ? '#007AFF' : '#657786'}
                />
                <Text style={[
                  styles.categoryLabel,
                  category === cat.value && styles.categoryLabelSelected,
                ]}>
                  {cat.label}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>

        {/* Title Input */}
        <View style={styles.section}>
          <Text style={styles.label}>Title</Text>
          <TextInput
            style={styles.input}
            value={title}
            onChangeText={setTitle}
            placeholder="Brief summary of the problem"
            placeholderTextColor="#AAB8C2"
            maxLength={100}
          />
          <Text style={styles.charCount}>{title.length}/100</Text>
        </View>

        {/* Description Input */}
        <View style={styles.section}>
          <Text style={styles.label}>Description</Text>
          <Text style={styles.hint}>
            Please include steps to reproduce the issue or details about your request
          </Text>
          <TextInput
            style={[styles.input, styles.textArea]}
            value={description}
            onChangeText={setDescription}
            placeholder="Describe the problem in detail..."
            placeholderTextColor="#AAB8C2"
            multiline
            numberOfLines={8}
            textAlignVertical="top"
            maxLength={1000}
          />
          <Text style={styles.charCount}>{description.length}/1000</Text>
        </View>

        {/* Account Info */}
        <View style={styles.infoBox}>
          <Ionicons name="information-circle" size={20} color="#007AFF" />
          <View style={styles.infoContent}>
            <Text style={styles.infoText}>
              Your report will be sent from: <Text style={styles.infoEmail}>{auth.user?.email}</Text>
            </Text>
          </View>
        </View>

        {/* Submit Button */}
        <TouchableOpacity
          style={[styles.submitButton, isSubmitting && styles.submitButtonDisabled]}
          onPress={handleSubmit}
          disabled={isSubmitting}
        >
          {isSubmitting ? (
            <ActivityIndicator color="#FFFFFF" />
          ) : (
            <>
              <Ionicons name="send" size={20} color="#FFFFFF" />
              <Text style={styles.submitButtonText}>Submit Report</Text>
            </>
          )}
        </TouchableOpacity>

        {/* Alternative Contact */}
        <View style={styles.alternative}>
          <Text style={styles.alternativeText}>
            Or email us directly at{' '}
            <Text style={styles.alternativeEmail}>support@egwallet.com</Text>
          </Text>
        </View>
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
  form: {
    padding: 16,
  },
  section: {
    marginBottom: 24,
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
  categoryGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  categoryOption: {
    flex: 1,
    minWidth: '45%',
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#E1E8ED',
    gap: 8,
  },
  categoryOptionSelected: {
    borderColor: '#007AFF',
    backgroundColor: '#F0F7FF',
  },
  categoryLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: '#657786',
    flex: 1,
  },
  categoryLabelSelected: {
    color: '#007AFF',
  },
  input: {
    backgroundColor: '#FFFFFF',
    borderWidth: 1,
    borderColor: '#E1E8ED',
    borderRadius: 12,
    padding: 14,
    fontSize: 15,
    color: '#1C1E21',
  },
  textArea: {
    height: 150,
    paddingTop: 14,
  },
  charCount: {
    fontSize: 12,
    color: '#AAB8C2',
    textAlign: 'right',
    marginTop: 4,
  },
  infoBox: {
    flexDirection: 'row',
    backgroundColor: '#F0F7FF',
    padding: 14,
    borderRadius: 12,
    marginBottom: 24,
    gap: 10,
  },
  infoContent: {
    flex: 1,
  },
  infoText: {
    fontSize: 13,
    color: '#657786',
    lineHeight: 18,
  },
  infoEmail: {
    fontWeight: '600',
    color: '#007AFF',
  },
  submitButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#007AFF',
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
  alternative: {
    padding: 16,
    alignItems: 'center',
  },
  alternativeText: {
    fontSize: 13,
    color: '#657786',
    textAlign: 'center',
  },
  alternativeEmail: {
    fontWeight: '600',
    color: '#007AFF',
  },
});
