import React, { useEffect, useState, useCallback } from 'react';
import {
  View, Text, FlatList, StyleSheet, TouchableOpacity,
  ActivityIndicator, RefreshControl,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';

type Notif = {
  id: string;
  type: 'money_received' | 'money_sent' | 'deposit' | 'withdrawal' | 'failed' | string;
  title: string;
  body: string;
  read: boolean;
  createdAt: number;
  metadata?: any;
};

const TYPE_ICON: Record<string, { icon: string; color: string; bg: string }> = {
  money_received: { icon: 'arrow-down-circle', color: '#15803D', bg: '#DCFCE7' },
  money_sent:     { icon: 'arrow-up-circle',   color: '#1565C0', bg: '#DBEAFE' },
  deposit:        { icon: 'add-circle',         color: '#A16207', bg: '#FEF9C3' },
  withdrawal:     { icon: 'log-out',            color: '#F57C00', bg: '#FFF3E0' },
  failed:         { icon: 'close-circle',       color: '#DC2626', bg: '#FEE2E2' },
};

function getIconMeta(type: string) {
  return TYPE_ICON[type] ?? { icon: 'notifications', color: '#1565C0', bg: '#DBEAFE' };
}

function formatRelTime(ts: number) {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(diff / 3600000);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(diff / 86400000);
  return `${days}d ago`;
}

export default function NotificationsScreen() {
  const auth = useAuth();
  const navigation = useNavigation();
  const [notifs, setNotifs] = useState<Notif[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    if (!auth.token) return;
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/notifications`, {
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setNotifs(data.notifications || []);
      }
    } catch {
      // Offline — show whatever we have
    } finally {
      setLoading(false);
    }
  }

  async function markAllRead() {
    if (!auth.token) return;
    try {
      await fetch(`${API_BASE}/notifications/read-all`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      setNotifs(prev => prev.map(n => ({ ...n, read: true })));
    } catch {}
  }

  async function markOneRead(id: string) {
    if (!auth.token) return;
    try {
      await fetch(`${API_BASE}/notifications/${id}/read`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${auth.token}` },
      });
      setNotifs(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    } catch {
      setNotifs(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
    }
  }

  useFocusEffect(useCallback(() => { load(); }, [auth.token]));

  async function onRefresh() {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }

  const unread = notifs.filter(n => !n.read).length;

  if (loading && notifs.length === 0) {
    return (
      <View style={styles.centered}>
        <ActivityIndicator size="large" color="#1565C0" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header actions */}
      {unread > 0 && (
        <TouchableOpacity style={styles.markAllBtn} onPress={markAllRead} activeOpacity={0.8}>
          <Ionicons name="checkmark-done" size={16} color="#1565C0" />
          <Text style={styles.markAllText}>Mark all as read</Text>
        </TouchableOpacity>
      )}

      <FlatList
        data={notifs}
        keyExtractor={item => item.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} colors={['#1565C0']} />}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="notifications-off-outline" size={52} color="#AAB8C2" />
            <Text style={styles.emptyTitle}>No notifications yet</Text>
            <Text style={styles.emptySubtitle}>Activity like deposits, sends, and withdrawals will appear here.</Text>
          </View>
        }
        renderItem={({ item }) => {
          const { icon, color, bg } = getIconMeta(item.type);
          return (
            <TouchableOpacity
              style={[styles.card, !item.read && styles.cardUnread]}
              onPress={() => markOneRead(item.id)}
              activeOpacity={0.8}
            >
              <View style={[styles.iconWrap, { backgroundColor: bg }]}>
                <Ionicons name={icon as any} size={22} color={color} />
              </View>
              <View style={styles.textWrap}>
                <View style={styles.titleRow}>
                  <Text style={[styles.title, !item.read && styles.titleBold]}>{item.title}</Text>
                  {!item.read && <View style={styles.unreadDot} />}
                </View>
                <Text style={styles.body} numberOfLines={2}>{item.body}</Text>
                <Text style={styles.time}>{formatRelTime(item.createdAt)}</Text>
              </View>
            </TouchableOpacity>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#F5F7FA' },
  centered: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  markAllBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 10,
    backgroundColor: '#EEF3FA',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  markAllText: { fontSize: 14, fontWeight: '600', color: '#1565C0' },
  list: { padding: 12, paddingTop: 8 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: '#fff',
    borderRadius: 14,
    padding: 14,
    marginBottom: 10,
    gap: 12,
    shadowColor: '#1565C0',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 8,
    elevation: 2,
  },
  cardUnread: {
    borderLeftWidth: 3,
    borderLeftColor: '#1565C0',
  },
  iconWrap: {
    width: 44,
    height: 44,
    borderRadius: 22,
    justifyContent: 'center',
    alignItems: 'center',
  },
  textWrap: { flex: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 3 },
  title: { fontSize: 14, fontWeight: '500', color: '#0D1B2E', flex: 1 },
  titleBold: { fontWeight: '700' },
  unreadDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: '#1565C0',
  },
  body: { fontSize: 13, color: '#657786', lineHeight: 18 },
  time: { fontSize: 11, color: '#AAB8C2', marginTop: 4 },
  empty: {
    alignItems: 'center',
    paddingTop: 80,
    paddingHorizontal: 32,
    gap: 12,
  },
  emptyTitle: { fontSize: 18, fontWeight: '700', color: '#0D1B2E' },
  emptySubtitle: { fontSize: 14, color: '#657786', textAlign: 'center', lineHeight: 20 },
});
