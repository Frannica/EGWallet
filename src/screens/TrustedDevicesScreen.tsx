import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, FlatList, TouchableOpacity, Alert, ActivityIndicator, RefreshControl } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';

type Device = {
  id: string;
  name: string;
  type: string;
  firstSeen: number;
  lastSeen: number;
  trusted: boolean;
};

export default function TrustedDevicesScreen() {
  const auth = useAuth();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    loadDevices();
  }, []);

  async function loadDevices() {
    try {
      const res = await fetch(`${API_BASE}/devices`, {
        headers: {
          'Authorization': `Bearer ${auth.token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        setDevices(data);
      }
    } catch (error) {
      console.error('Failed to load devices:', error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function handleRefresh() {
    setRefreshing(true);
    await loadDevices();
  }

  async function handleRemoveDevice(device: Device) {
    Alert.alert(
      'Remove Device',
      `Are you sure you want to remove "${device.name}"? You will need to verify this device again next time you sign in from it.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            try {
              const res = await fetch(`${API_BASE}/devices/${device.id}`, {
                method: 'DELETE',
                headers: {
                  'Authorization': `Bearer ${auth.token}`,
                },
              });

              if (res.ok) {
                setDevices(prev => prev.filter(d => d.id !== device.id));
                Alert.alert('Success', 'Device removed successfully');
              } else {
                throw new Error('Failed to remove device');
              }
            } catch (error) {
              Alert.alert('Error', 'Failed to remove device. Please try again.');
            }
          },
        },
      ]
    );
  }

  async function handleTrustDevice(device: Device) {
    try {
      const res = await fetch(`${API_BASE}/devices/${device.id}/trust`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${auth.token}`,
        },
      });

      if (res.ok) {
        setDevices(prev => prev.map(d => 
          d.id === device.id ? { ...d, trusted: true } : d
        ));
        Alert.alert('Success', 'Device marked as trusted');
      } else {
        throw new Error('Failed to trust device');
      }
    } catch (error) {
      Alert.alert('Error', 'Failed to trust device. Please try again.');
    }
  }

  function formatDate(timestamp: number): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
  }

  function getDeviceIcon(type: string): keyof typeof Ionicons.glyphMap {
    const lowerType = type.toLowerCase();
    if (lowerType.includes('phone')) return 'phone-portrait';
    if (lowerType.includes('tablet')) return 'tablet-portrait';
    if (lowerType.includes('desktop')) return 'desktop';
    if (lowerType.includes('tv')) return 'tv';
    return 'hardware-chip';
  }

  function renderDevice({ item }: { item: Device }) {
    return (
      <View style={styles.deviceCard}>
        <View style={styles.deviceIcon}>
          <Ionicons name={getDeviceIcon(item.type)} size={32} color="#007AFF" />
          {item.trusted && (
            <View style={styles.trustedBadge}>
              <Ionicons name="shield-checkmark" size={16} color="#34C759" />
            </View>
          )}
        </View>

        <View style={styles.deviceInfo}>
          <Text style={styles.deviceName}>{item.name}</Text>
          <Text style={styles.deviceType}>{item.type}</Text>
          <View style={styles.deviceMeta}>
            <Text style={styles.metaText}>
              Last seen: {formatDate(item.lastSeen)}
            </Text>
            <Text style={styles.metaText}>
              Added: {formatDate(item.firstSeen)}
            </Text>
          </View>
        </View>

        <View style={styles.deviceActions}>
          {!item.trusted && (
            <TouchableOpacity
              style={styles.trustButton}
              onPress={() => handleTrustDevice(item)}
            >
              <Ionicons name="shield-checkmark" size={20} color="#34C759" />
            </TouchableOpacity>
          )}
          <TouchableOpacity
            style={styles.removeButton}
            onPress={() => handleRemoveDevice(item)}
          >
            <Ionicons name="trash" size={20} color="#FF3B30" />
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="shield" size={40} color="#007AFF" />
        <Text style={styles.title}>Trusted Devices</Text>
        <Text style={styles.subtitle}>
          Manage devices that have access to your account
        </Text>
      </View>

      {devices.length === 0 ? (
        <View style={styles.emptyState}>
          <Ionicons name="phone-portrait-outline" size={64} color="#AAB8C2" />
          <Text style={styles.emptyText}>No devices found</Text>
          <Text style={styles.emptySubtext}>
            Devices will appear here when you sign in
          </Text>
        </View>
      ) : (
        <FlatList
          data={devices}
          keyExtractor={(item) => item.id}
          renderItem={renderDevice}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor="#007AFF"
            />
          }
        />
      )}

      <View style={styles.infoBox}>
        <Ionicons name="information-circle" size={20} color="#007AFF" />
        <Text style={styles.infoText}>
          You'll receive an alert when signing in from a new device. Remove devices you don't recognize immediately.
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F5F7FA',
  },
  centerContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  header: {
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#FFFFFF',
    borderBottomWidth: 1,
    borderBottomColor: '#E1E8ED',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    color: '#1C1E21',
    marginTop: 12,
  },
  subtitle: {
    fontSize: 14,
    color: '#657786',
    marginTop: 8,
    textAlign: 'center',
  },
  list: {
    padding: 16,
    paddingBottom: 100,
  },
  deviceCard: {
    flexDirection: 'row',
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    padding: 16,
    marginBottom: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  deviceIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: '#F0F7FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  trustedBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    padding: 2,
  },
  deviceInfo: {
    flex: 1,
  },
  deviceName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1E21',
    marginBottom: 4,
  },
  deviceType: {
    fontSize: 14,
    color: '#657786',
    marginBottom: 8,
  },
  deviceMeta: {
    gap: 4,
  },
  metaText: {
    fontSize: 12,
    color: '#AAB8C2',
  },
  deviceActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  trustButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#F0FAF4',
    justifyContent: 'center',
    alignItems: 'center',
  },
  removeButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: '#FFF0F0',
    justifyContent: 'center',
    alignItems: 'center',
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '600',
    color: '#657786',
    marginTop: 16,
  },
  emptySubtext: {
    fontSize: 14,
    color: '#AAB8C2',
    marginTop: 8,
    textAlign: 'center',
  },
  infoBox: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    backgroundColor: '#F0F7FF',
    padding: 16,
    borderTopWidth: 1,
    borderTopColor: '#E1E8ED',
    gap: 12,
  },
  infoText: {
    flex: 1,
    fontSize: 13,
    color: '#657786',
    lineHeight: 18,
  },
});
