import AsyncStorage from '@react-native-async-storage/async-storage';

export interface Contact {
  id: string;
  name: string;
  walletId: string;
  avatar?: string;
  favorite?: boolean;
  lastUsed?: number;
  notes?: string;
}

const CONTACTS_STORAGE_KEY = 'egwallet_contacts';

/**
 * Load all contacts from storage
 */
export async function loadContacts(): Promise<Contact[]> {
  try {
    const data = await AsyncStorage.getItem(CONTACTS_STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.warn('Failed to load contacts', e);
    return [];
  }
}

/**
 * Save contact to storage
 */
export async function saveContact(contact: Omit<Contact, 'id'>): Promise<Contact> {
  try {
    const contacts = await loadContacts();
    const newContact: Contact = {
      ...contact,
      id: Date.now().toString(),
      lastUsed: Date.now(),
    };
    contacts.push(newContact);
    await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
    return newContact;
  } catch (e) {
    console.warn('Failed to save contact', e);
    throw new Error('Failed to save contact');
  }
}

/**
 * Update existing contact
 */
export async function updateContact(id: string, updates: Partial<Contact>): Promise<void> {
  try {
    const contacts = await loadContacts();
    const index = contacts.findIndex(c => c.id === id);
    if (index !== -1) {
      contacts[index] = { ...contacts[index], ...updates };
      await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(contacts));
    }
  } catch (e) {
    console.warn('Failed to update contact', e);
    throw new Error('Failed to update contact');
  }
}

/**
 * Delete contact
 */
export async function deleteContact(id: string): Promise<void> {
  try {
    const contacts = await loadContacts();
    const filtered = contacts.filter(c => c.id !== id);
    await AsyncStorage.setItem(CONTACTS_STORAGE_KEY, JSON.stringify(filtered));
  } catch (e) {
    console.warn('Failed to delete contact', e);
    throw new Error('Failed to delete contact');
  }
}

/**
 * Search contacts by name or wallet ID
 */
export async function searchContacts(query: string): Promise<Contact[]> {
  const contacts = await loadContacts();
  const lowerQuery = query.toLowerCase();
  return contacts.filter(
    c =>
      c.name.toLowerCase().includes(lowerQuery) ||
      c.walletId.toLowerCase().includes(lowerQuery)
  );
}

/**
 * Get favorite contacts
 */
export async function getFavoriteContacts(): Promise<Contact[]> {
  const contacts = await loadContacts();
  return contacts.filter(c => c.favorite);
}

/**
 * Get recently used contacts
 */
export async function getRecentContacts(limit: number = 5): Promise<Contact[]> {
  const contacts = await loadContacts();
  return contacts
    .filter(c => c.lastUsed)
    .sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0))
    .slice(0, limit);
}

/**
 * Update last used timestamp for a contact
 */
export async function markContactAsUsed(walletId: string): Promise<void> {
  try {
    const contacts = await loadContacts();
    const contact = contacts.find(c => c.walletId === walletId);
    if (contact) {
      await updateContact(contact.id, { lastUsed: Date.now() });
    }
  } catch (e) {
    console.warn('Failed to mark contact as used', e);
  }
}
