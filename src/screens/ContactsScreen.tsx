import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, TextInput, Alert } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  loadContacts,
  saveContact,
  deleteContact,
  updateContact,
  Contact,
  getFavoriteContacts,
} from '../utils/ContactsManager';
import { useTheme } from '../contexts/ThemeContext';

export default function ContactsScreen() {
  const navigation = useNavigation();
  const { colors } = useTheme();
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddForm, setShowAddForm] = useState(false);
  const [newContactName, setNewContactName] = useState('');
  const [newContactWalletId, setNewContactWalletId] = useState('');

  useEffect(() => {
    loadAllContacts();
  }, []);

  async function loadAllContacts() {
    const all = await loadContacts();
    setContacts(all);
  }

  async function handleAddContact() {
    if (!newContactName.trim() || !newContactWalletId.trim()) {
      Alert.alert('Error', 'Please enter both name and wallet ID');
      return;
    }

    try {
      await saveContact({
        name: newContactName.trim(),
        walletId: newContactWalletId.trim(),
        favorite: false,
      });
      setNewContactName('');
      setNewContactWalletId('');
      setShowAddForm(false);
      loadAllContacts();
      Alert.alert('Success', 'Contact added successfully');
    } catch (e) {
      Alert.alert('Error', 'Failed to add contact');
    }
  }

  async function handleDeleteContact(id: string, name: string) {
    Alert.alert(
      'Delete Contact',
      `Are you sure you want to delete ${name}?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await deleteContact(id);
            loadAllContacts();
          },
        },
      ]
    );
  }

  async function handleToggleFavorite(contact: Contact) {
    await updateContact(contact.id, { favorite: !contact.favorite });
    loadAllContacts();
  }

  const filteredContacts = contacts.filter(
    c =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      c.walletId.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const dynamicStyles = getDynamicStyles(colors);

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Search Bar */}
      <View style={[styles.searchContainer, { backgroundColor: colors.card }]}>
        <TextInput
          style={[styles.searchInput, { color: colors.text }]}
          placeholder="Search contacts..."
          placeholderTextColor={colors.textSecondary}
          value={searchQuery}
          onChangeText={setSearchQuery}
        />
      </View>

      {/* Add Contact Button */}
      {!showAddForm && (
        <TouchableOpacity
          style={[styles.addButton, { backgroundColor: colors.primary }]}
          onPress={() => setShowAddForm(true)}
        >
          <Text style={styles.addButtonText}>+ Add New Contact</Text>
        </TouchableOpacity>
      )}

      {/* Add Contact Form */}
      {showAddForm && (
        <View style={[styles.addForm, { backgroundColor: colors.card }]}>
          <TextInput
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
            placeholder="Contact Name"
            placeholderTextColor={colors.textSecondary}
            value={newContactName}
            onChangeText={setNewContactName}
          />
          <TextInput
            style={[styles.input, { color: colors.text, borderColor: colors.border }]}
            placeholder="Wallet ID"
            placeholderTextColor={colors.textSecondary}
            value={newContactWalletId}
            onChangeText={setNewContactWalletId}
          />
          <View style={styles.formButtons}>
            <TouchableOpacity
              style={[styles.formButton, styles.cancelButton, { borderColor: colors.border }]}
              onPress={() => {
                setShowAddForm(false);
                setNewContactName('');
                setNewContactWalletId('');
              }}
            >
              <Text style={[styles.formButtonText, { color: colors.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.formButton, styles.saveButton, { backgroundColor: colors.primary }]}
              onPress={handleAddContact}
            >
              <Text style={[styles.formButtonText, { color: '#fff' }]}>Save</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Contacts List */}
      <FlatList
        data={filteredContacts}
        keyExtractor={item => item.id}
        renderItem={({ item }) => (
          <View style={[styles.contactCard, { backgroundColor: colors.card }]}>
            <View style={styles.contactInfo}>
              <View style={styles.contactHeader}>
                <Text style={[styles.contactName, { color: colors.text }]}>{item.name}</Text>
                <TouchableOpacity onPress={() => handleToggleFavorite(item)}>
                  <Text style={styles.favoriteIcon}>{item.favorite ? '⭐' : '☆'}</Text>
                </TouchableOpacity>
              </View>
              <Text style={[styles.contactWalletId, { color: colors.textSecondary }]}>
                {item.walletId}
              </Text>
              {item.notes && (
                <Text style={[styles.contactNotes, { color: colors.textSecondary }]}>
                  {item.notes}
                </Text>
              )}
            </View>
            <TouchableOpacity
              style={styles.deleteButton}
              onPress={() => handleDeleteContact(item.id, item.name)}
            >
              <Text style={styles.deleteIcon}>🗑️</Text>
            </TouchableOpacity>
          </View>
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
              {searchQuery ? 'No contacts found' : 'No contacts yet. Add your first contact!'}
            </Text>
          </View>
        }
        contentContainerStyle={styles.listContent}
      />
    </View>
  );
}

function getDynamicStyles(colors: any) {
  return StyleSheet.create({});
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  searchContainer: {
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#eee',
  },
  searchInput: {
    padding: 12,
    fontSize: 16,
    borderRadius: 8,
    backgroundColor: 'rgba(0,0,0,0.05)',
  },
  addButton: {
    margin: 16,
    padding: 16,
    borderRadius: 8,
    alignItems: 'center',
  },
  addButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  addForm: {
    padding: 16,
    margin: 16,
    borderRadius: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    marginBottom: 12,
    fontSize: 16,
  },
  formButtons: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 8,
  },
  formButton: {
    flex: 1,
    padding: 12,
    borderRadius: 8,
    alignItems: 'center',
  },
  cancelButton: {
    borderWidth: 1,
  },
  saveButton: {},
  formButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
  listContent: {
    padding: 16,
  },
  contactCard: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 16,
    borderRadius: 8,
    marginBottom: 12,
  },
  contactInfo: {
    flex: 1,
  },
  contactHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 6,
  },
  contactName: {
    fontSize: 18,
    fontWeight: '600',
    marginRight: 8,
  },
  favoriteIcon: {
    fontSize: 18,
  },
  contactWalletId: {
    fontSize: 14,
    fontFamily: 'monospace',
    marginBottom: 4,
  },
  contactNotes: {
    fontSize: 13,
    fontStyle: 'italic',
  },
  deleteButton: {
    padding: 8,
  },
  deleteIcon: {
    fontSize: 20,
  },
  emptyState: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 64,
  },
  emptyText: {
    fontSize: 16,
    textAlign: 'center',
  },
});
