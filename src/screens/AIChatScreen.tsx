import React, { useState, useRef, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TextInput, TouchableOpacity, KeyboardAvoidingView, Platform, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';

type Message = {
  id: string;
  text: string;
  sender: 'user' | 'ai';
  timestamp: number;
  suggestions?: string[];
  ticketCreated?: {
    ticketId: string;
    priority: 'urgent' | 'high' | 'normal';
    sla: string;
    escalated?: boolean;
    isFraudAlert?: boolean;
  };
  needsMoreInfo?: {
    fields: Array<{
      name: string;
      label: string;
      type: string;
      required: boolean;
      hint?: string;
    }>;
    reason: string;
  };
  recentTransactions?: Array<{
    id: string;
    fullId: string;
    amount: number;
    type: string;
    status: string;
    timestamp: number;
    recipient?: string;
  }>;
  fraudQuestions?: Array<{
    id: string;
    question: string;
    type: 'transaction_select' | 'datetime' | 'yes_no';
  }>;
};

type QuickAction = {
  id: string;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  query: string;
};

export default function AIChatScreen() {
  const auth = useAuth();
  const [messages, setMessages] = useState<Message[]>([{
    id: '1',
    text: 'Hello! I\'m your EGWallet AI assistant. How can I help you today?',
    sender: 'ai',
    timestamp: Date.now(),
    suggestions: [
      'Check my transaction',
      'Report a problem',
      'Account limits',
      'How to send money'
    ]
  }]);
  const [inputText, setInputText] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [structuredDataForm, setStructuredDataForm] = useState<any>(null);
  const [formData, setFormData] = useState<Record<string, string>>({});
  const [language, setLanguage] = useState('en');
  const [showLanguageMenu, setShowLanguageMenu] = useState(false);
  const flatListRef = useRef<FlatList>(null);

  const languages = [
    { code: 'en', flag: '🇺🇸', name: 'English' },
    { code: 'es', flag: '🇪🇸', name: 'Español' },
    { code: 'fr', flag: '🇫🇷', name: 'Français' },
    { code: 'pt', flag: '🇧🇷', name: 'Português' },
    { code: 'zh', flag: '🇨🇳', name: '中文' },
    { code: 'ja', flag: '🇯🇵', name: '日本語' },
    { code: 'ru', flag: '🇷🇺', name: 'Русский' },
    { code: 'de', flag: '🇩🇪', name: 'Deutsch' }
  ];

  const quickActions: QuickAction[] = [
    { id: '1', icon: 'search', label: 'Track Transaction', query: 'Check my latest transaction status' },
    { id: '2', icon: 'alert-circle', label: 'Report Issue', query: 'I want to report a problem' },
    { id: '3', icon: 'card', label: 'Virtual Cards', query: 'How do I create a virtual card?' },
    { id: '4', icon: 'shield-checkmark', label: 'Verify Identity', query: 'Help me verify my identity' },
  ];

  useEffect(() => {
    // Scroll to bottom when new messages arrive
    if (messages.length > 0) {
      setTimeout(() => {
        flatListRef.current?.scrollToEnd({ animated: true });
      }, 100);
    }
  }, [messages]);

  async function sendMessage(text: string, structuredData?: Record<string, string>) {
    if (!text.trim()) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      text: text.trim(),
      sender: 'user',
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInputText('');
    setStructuredDataForm(null); // Clear form
    setFormData({});
    setIsTyping(true);

    try {
      // Call AI backend
      const response = await fetch(`${API_BASE}/ai/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${auth.token}`,
        },
        body: JSON.stringify({
          message: text.trim(),
          conversationHistory: messages.slice(-5), // Last 5 messages for context
          structuredData: structuredData || null,
          language: language, // Send selected language
        }),
      });

      if (response.ok) {
        const data = await response.json();
        
        const aiMessage: Message = {
          id: (Date.now() + 1).toString(),
          text: data.response,
          sender: 'ai',
          timestamp: Date.now(),
          suggestions: data.suggestions,
          ticketCreated: data.ticketCreated, // Include ticket info if created
          needsMoreInfo: data.needsMoreInfo, // Structured data collection
          recentTransactions: data.recentTransactions, // For fraud cases
          fraudQuestions: data.fraudQuestions, // For fraud investigation
        };

        setMessages(prev => [...prev, aiMessage]);
        
        // Show structured data form if AI requests it
        if (data.needsMoreInfo) {
          setStructuredDataForm(data.needsMoreInfo);
        }
      } else {
        throw new Error('AI response failed');
      }
    } catch (error) {
      // Fallback response if AI fails
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        text: 'I\'m having trouble processing your request right now. Please try again or contact support at support@egwallet.com',
        sender: 'ai',
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsTyping(false);
    }
  }

  function handleQuickAction(action: QuickAction) {
    sendMessage(action.query);
  }

  function handleSuggestion(suggestion: string) {
    sendMessage(suggestion);
  }

  function renderMessage({ item }: { item: Message }) {
    const isUser = item.sender === 'user';

    return (
      <View style={[styles.messageContainer, isUser ? styles.userMessageContainer : styles.aiMessageContainer]}>
        {!isUser && (
          <View style={styles.aiAvatar}>
            <Ionicons name="sparkles" size={16} color="#FFFFFF" />
          </View>
        )}
        
        <View style={[styles.messageBubble, isUser ? styles.userBubble : styles.aiBubble]}>
          <Text style={[styles.messageText, isUser ? styles.userText : styles.aiText]}>
            {item.text}
          </Text>
          
          {/* Support ticket created alert */}
          {item.ticketCreated && (
            <View style={[
              styles.ticketAlert,
              item.ticketCreated.priority === 'urgent' && styles.ticketAlertUrgent,
              item.ticketCreated.isFraudAlert && styles.fraudAlert
            ]}>
              <View style={styles.ticketAlertHeader}>
                <Ionicons 
                  name={item.ticketCreated.isFraudAlert ? "warning" : item.ticketCreated.escalated ? "alert-circle" : "checkmark-circle"} 
                  size={18} 
                  color={item.ticketCreated.isFraudAlert || item.ticketCreated.priority === 'urgent' ? "#FF3B30" : "#34C759"} 
                />
                <Text style={styles.ticketAlertTitle}>
                  {item.ticketCreated.isFraudAlert ? "🚨 FRAUD ALERT - URGENT" : item.ticketCreated.escalated ? "⚡ Escalated Support Ticket" : "✓ Support Ticket Created"}
                </Text>
              </View>
              <Text style={styles.ticketId}>Ticket #{item.ticketCreated.ticketId}</Text>
              <Text style={styles.ticketSLA}>
                Expected response: {item.ticketCreated.sla}
              </Text>
              <Text style={styles.ticketPriority}>
                Priority: {item.ticketCreated.priority.toUpperCase()}
              </Text>
            </View>
          )}
          
          {/* Recent transactions for fraud cases */}
          {item.recentTransactions && item.recentTransactions.length > 0 && (
            <View style={styles.transactionsContainer}>
              <Text style={styles.transactionsTitle}>Recent Transactions:</Text>
              {item.recentTransactions.map((tx, index) => (
                <TouchableOpacity
                  key={tx.fullId}
                  style={styles.transactionItem}
                  onPress={() => {
                    sendMessage(`I want to report transaction ${tx.id} (${tx.type === 'send' ? '-' : '+'}$${Math.abs(tx.amount).toFixed(2)}) as unauthorized.`);
                  }}
                >
                  <View style={styles.transactionRow}>
                    <Ionicons 
                      name={tx.status === 'pending' ? 'time-outline' : tx.status === 'completed' ? 'checkmark-circle' : 'close-circle'} 
                      size={16} 
                      color={tx.status === 'pending' ? '#FF9500' : tx.status === 'completed' ? '#34C759' : '#FF3B30'} 
                    />
                    <Text style={styles.transactionAmount}>
                      {tx.type === 'send' ? '-' : '+'}${Math.abs(tx.amount).toFixed(2)}
                    </Text>
                    <Text style={styles.transactionId}>{tx.id}</Text>
                  </View>
                  <Text style={styles.transactionStatus}>
                    {tx.status.toUpperCase()} • {new Date(tx.timestamp).toLocaleDateString()}
                  </Text>
                </TouchableOpacity>
              ))}
            </View>
          )}
          
          {item.suggestions && item.suggestions.length > 0 && (
            <View style={styles.suggestionsContainer}>
              {item.suggestions.map((suggestion, index) => (
                <TouchableOpacity
                  key={index}
                  style={styles.suggestionChip}
                  onPress={() => handleSuggestion(suggestion)}
                >
                  <Text style={styles.suggestionText}>{suggestion}</Text>
                  <Ionicons name="chevron-forward" size={14} color="#007AFF" />
                </TouchableOpacity>
              ))}
            </View>
          )}
        </View>

        {isUser && (
          <View style={styles.userAvatar}>
            <Ionicons name="person" size={16} color="#FFFFFF" />
          </View>
        )}
      </View>
    );
  }

  return (
    <KeyboardAvoidingView 
      style={styles.container} 
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      keyboardVerticalOffset={90}
    >
      <View style={styles.header}>
        <View style={styles.headerContent}>
          <View style={styles.aiIcon}>
            <Ionicons name="sparkles" size={24} color="#007AFF" />
          </View>
          <View style={{ flex: 1 }}>
            <Text style={styles.headerTitle}>AI Assistant</Text>
            <Text style={styles.headerSubtitle}>Powered by EGWallet AI</Text>
          </View>
          <TouchableOpacity
            style={styles.languageButton}
            onPress={() => setShowLanguageMenu(!showLanguageMenu)}
          >
            <Text style={styles.languageButtonText}>
              {languages.find(l => l.code === language)?.flag} {language.toUpperCase()}
            </Text>
            <Ionicons name="chevron-down" size={16} color="#007AFF" />
          </TouchableOpacity>
        </View>
        
        {/* Language Selector Dropdown */}
        {showLanguageMenu && (
          <View style={styles.languageMenu}>
            {languages.map(lang => (
              <TouchableOpacity
                key={lang.code}
                style={[
                  styles.languageMenuItem,
                  language === lang.code && styles.languageMenuItemActive
                ]}
                onPress={async () => {
                  setLanguage(lang.code);
                  setShowLanguageMenu(false);
                  
                  // Update user language preference
                  try {
                    await fetch(`${API_BASE}/user/language`, {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${auth.token}`,
                      },
                      body: JSON.stringify({ language: lang.code }),
                    });
                  } catch (error) {
                    console.log('Failed to save language preference');
                  }
                }}
              >
                <Text style={styles.languageMenuFlag}>{lang.flag}</Text>
                <Text style={[
                  styles.languageMenuText,
                  language === lang.code && styles.languageMenuTextActive
                ]}>
                  {lang.name}
                </Text>
                {language === lang.code && (
                  <Ionicons name="checkmark" size={20} color="#007AFF" />
                )}
              </TouchableOpacity>
            ))}
          </View>
        )}
      </View>

      {/* Quick Actions */}
      {messages.length <= 1 && (
        <View style={styles.quickActionsContainer}>
          <Text style={styles.quickActionsTitle}>Quick Actions</Text>
          <View style={styles.quickActionsGrid}>
            {quickActions.map(action => (
              <TouchableOpacity
                key={action.id}
                style={styles.quickActionCard}
                onPress={() => handleQuickAction(action)}
              >
                <Ionicons name={action.icon} size={24} color="#007AFF" />
                <Text style={styles.quickActionLabel}>{action.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      <FlatList
        ref={flatListRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messagesList}
        showsVerticalScrollIndicator={false}
      />

      {isTyping && (
        <View style={styles.typingIndicator}>
          <View style={styles.typingDot} />
          <View style={styles.typingDot} />
          <View style={styles.typingDot} />
          <Text style={styles.typingText}>AI is typing...</Text>
        </View>
      )}

      {/* Structured Data Collection Form */}
      {structuredDataForm && (
        <View style={styles.dataCollectionForm}>
          <View style={styles.formHeader}>
            <Ionicons name="document-text" size={20} color="#007AFF" />
            <Text style={styles.formTitle}>{structuredDataForm.reason}</Text>
          </View>
          
          {structuredDataForm.fields.map((field: any, index: number) => (
            <View key={index} style={styles.formField}>
              <Text style={styles.fieldLabel}>
                {field.label} {field.required && <Text style={styles.required}>*</Text>}
              </Text>
              <TextInput
                style={styles.fieldInput}
                value={formData[field.name] || ''}
                onChangeText={(text) => setFormData(prev => ({ ...prev, [field.name]: text }))}
                placeholder={field.hint || `Enter ${field.label.toLowerCase()}`}
                placeholderTextColor="#AAB8C2"
                keyboardType={field.type === 'number' ? 'numeric' : 'default'}
              />
            </View>
          ))}
          
          <View style={styles.formActions}>
            <TouchableOpacity
              style={styles.formButtonSecondary}
              onPress={() => {
                setStructuredDataForm(null);
                setFormData({});
                sendMessage('Skip data collection and create general ticket');
              }}
            >
              <Text style={styles.formButtonSecondaryText}>Skip</Text>
            </TouchableOpacity>
            
            <TouchableOpacity
              style={styles.formButtonPrimary}
              onPress={() => {
                const requiredFields = structuredDataForm.fields.filter((f: any) => f.required);
                const allFieldsFilled = requiredFields.every((f: any) => formData[f.name]?.trim());
                
                if (!allFieldsFilled) {
                  alert('Please fill in all required fields');
                  return;
                }
                
                sendMessage('Submitting case details', formData);
              }}
            >
              <Text style={styles.formButtonPrimaryText}>Submit Details</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <View style={styles.inputContainer}>
        <TextInput
          style={styles.input}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Ask me anything..."
          placeholderTextColor="#AAB8C2"
          multiline
          maxLength={500}
        />
        <TouchableOpacity
          style={[styles.sendButton, !inputText.trim() && styles.sendButtonDisabled]}
          onPress={() => sendMessage(inputText)}
          disabled={!inputText.trim() || isTyping}
        >
          <Ionicons name="send" size={20} color="#FFFFFF" />
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  header: {
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
    paddingVertical: 12,
    paddingHorizontal: 16,
  },
  headerContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  aiIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F0F7FF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  headerTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: '#1C1E21',
  },
  headerSubtitle: {
    fontSize: 12,
    color: '#657786',
    marginTop: 2,
  },
  languageButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#F0F7FF',
    paddingVertical: 6,
    paddingHorizontal: 10,
    borderRadius: 8,
    gap: 4,
  },
  languageButtonText: {
    fontSize: 13,
    fontWeight: '600',
    color: '#007AFF',
  },
  languageMenu: {
    marginTop: 12,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: '#E1E8ED',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  languageMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F5F7FA',
    gap: 12,
  },
  languageMenuItemActive: {
    backgroundColor: '#F0F7FF',
  },
  languageMenuFlag: {
    fontSize: 24,
  },
  languageMenuText: {
    flex: 1,
    fontSize: 15,
    color: '#1C1E21',
  },
  languageMenuTextActive: {
    fontWeight: '600',
    color: '#007AFF',
  },
  quickActionsContainer: {
    padding: 16,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  quickActionsTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#657786',
    marginBottom: 12,
  },
  quickActionsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
  },
  quickActionCard: {
    flex: 1,
    minWidth: '45%',
    backgroundColor: '#F0F7FF',
    padding: 16,
    borderRadius: 12,
    alignItems: 'center',
    gap: 8,
  },
  quickActionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: '#007AFF',
    textAlign: 'center',
  },
  messagesList: {
    padding: 16,
    paddingBottom: 8,
  },
  messageContainer: {
    flexDirection: 'row',
    marginBottom: 16,
    alignItems: 'flex-end',
  },
  userMessageContainer: {
    justifyContent: 'flex-end',
  },
  aiMessageContainer: {
    justifyContent: 'flex-start',
  },
  aiAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 8,
  },
  userAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: '#34C759',
    justifyContent: 'center',
    alignItems: 'center',
    marginLeft: 8,
  },
  messageBubble: {
    maxWidth: '75%',
    padding: 12,
    borderRadius: 16,
  },
  userBubble: {
    backgroundColor: '#007AFF',
    borderBottomRightRadius: 4,
  },
  aiBubble: {
    backgroundColor: '#FFFFFF',
    borderBottomLeftRadius: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  messageText: {
    fontSize: 15,
    lineHeight: 20,
  },
  userText: {
    color: '#FFFFFF',
  },
  aiText: {
    color: '#1C1E21',
  },
  suggestionsContainer: {
    marginTop: 12,
    gap: 8,
  },
  suggestionChip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#F0F7FF',
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#007AFF',
  },
  suggestionText: {
    fontSize: 13,
    color: '#007AFF',
    fontWeight: '500',
    flex: 1,
  },
  ticketAlert: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#E8F5E9',
    borderRadius: 8,
    borderLeftWidth: 3,
    borderLeftColor: '#34C759',
  },
  ticketAlertUrgent: {
    backgroundColor: '#FFEBEE',
    borderLeftColor: '#FF3B30',
  },
  ticketAlertHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 6,
  },
  ticketAlertTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1C1E21',
  },
  ticketId: {
    fontSize: 13,
    fontWeight: '500',
    color: '#007AFF',
    marginBottom: 4,
  },
  ticketSLA: {
    fontSize: 12,
    color: '#657786',
    marginBottom: 2,
  },
  ticketPriority: {
    fontSize: 12,
    fontWeight: '500',
    color: '#1C1E21',
  },
  fraudAlert: {
    backgroundColor: '#FFF3E0',
    borderLeftColor: '#FF9500',
    borderLeftWidth: 4,
  },
  transactionsContainer: {
    marginTop: 12,
    padding: 12,
    backgroundColor: '#F8F9FA',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#E4E6EB',
  },
  transactionsTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: '#1C1E21',
    marginBottom: 8,
  },
  transactionItem: {
    padding: 10,
    backgroundColor: '#FFFFFF',
    borderRadius: 6,
    marginBottom: 6,
    borderWidth: 1,
    borderColor: '#E4E6EB',
  },
  transactionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 4,
  },
  transactionAmount: {
    fontSize: 14,
    fontWeight: '600',
    color: '#1C1E21',
  },
  transactionId: {
    fontSize: 12,
    color: '#657786',
    flex: 1,
  },
  transactionStatus: {
    fontSize: 11,
    color: '#8899A6',
    marginTop: 2,
  },
  dataCollectionForm: {
    backgroundColor: '#FFFFFF',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    borderWidth: 2,
    borderColor: '#007AFF',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 4,
  },
  formHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginBottom: 16,
  },
  formTitle: {
    fontSize: 15,
    fontWeight: '600',
    color: '#1C1E21',
    flex: 1,
  },
  formField: {
    marginBottom: 16,
  },
  fieldLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: '#1C1E21',
    marginBottom: 6,
  },
  required: {
    color: '#FF3B30',
  },
  fieldInput: {
    backgroundColor: '#F5F7FA',
    borderWidth: 1,
    borderColor: '#E1E8ED',
    borderRadius: 8,
    padding: 12,
    fontSize: 15,
    color: '#1C1E21',
  },
  formActions: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  formButtonPrimary: {
    flex: 1,
    backgroundColor: '#007AFF',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  formButtonPrimaryText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '600',
  },
  formButtonSecondary: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    paddingVertical: 12,
    borderRadius: 8,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: '#E1E8ED',
  },
  formButtonSecondaryText: {
    color: '#657786',
    fontSize: 15,
    fontWeight: '600',
  },
  typingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    gap: 6,
  },
  typingDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: '#AAB8C2',
  },
  typingText: {
    fontSize: 13,
    color: '#657786',
    marginLeft: 6,
    fontStyle: 'italic',
  },
  inputContainer: {
    flexDirection: 'row',
    padding: 12,
    backgroundColor: '#FFFFFF',
    borderTopWidth: 1,
    borderTopColor: '#E1E8ED',
    gap: 12,
    alignItems: 'flex-end',
  },
  input: {
    flex: 1,
    backgroundColor: '#F5F7FA',
    borderRadius: 20,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 15,
    color: '#1C1E21',
    maxHeight: 100,
  },
  sendButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  sendButtonDisabled: {
    opacity: 0.5,
  },
});
