import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';

type KYCStatus = 'not_started' | 'pending' | 'under_review' | 'approved' | 'rejected';

type KYCDocument = {
  id: string;
  type: 'id_card' | 'passport' | 'drivers_license' | 'proof_of_address';
  status: KYCStatus;
  uploadedAt: number;
  reviewedAt?: number;
  rejectionReason?: string;
};

export default function KYCVerificationScreen() {
  const auth = useAuth();
  const [kycStatus, setKycStatus] = useState<KYCStatus>('not_started');
  const [documents, setDocuments] = useState<KYCDocument[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    loadKYCStatus();
  }, []);

  async function loadKYCStatus() {
    try {
      const res = await fetch(`${API_BASE}/kyc/status`, {
        headers: {
          'Authorization': `Bearer ${auth.token}`,
        },
      });

      if (res.ok) {
        const data = await res.json();
        setKycStatus(data.status || 'not_started');
        setDocuments(data.documents || []);
      }
    } catch (error) {
      console.error('Failed to load KYC status:', error);
    } finally {
      setLoading(false);
    }
  }

  async function handleUploadDocument(type: KYCDocument['type']) {
    Alert.alert(
      'Document Upload',
      'In a production app, this would open your camera or file picker to upload a photo of your document. For this demo, we\'ll simulate the upload.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Simulate Upload',
          onPress: async () => {
            setUploading(true);
            try {
              // In production, you would:
              // 1. Use expo-image-picker to select/capture image
              // 2. Upload to your backend
              // 3. Backend would process with OCR/verification service
              
              // Simulated upload
              await new Promise(resolve => setTimeout(resolve, 1500));
              
              const newDoc: KYCDocument = {
                id: Math.random().toString(36).substring(7),
                type,
                status: 'under_review',
                uploadedAt: Date.now(),
              };
              
              setDocuments(prev => [...prev, newDoc]);
              setKycStatus('under_review');
              
              Alert.alert('Success', 'Document uploaded successfully! Our team will review it within 1-2 business days.');
            } catch (error) {
              Alert.alert('Error', 'Failed to upload document. Please try again.');
            } finally {
              setUploading(false);
            }
          },
        },
      ]
    );
  }

  function getStatusColor(status: KYCStatus): string {
    switch (status) {
      case 'approved': return '#34C759';
      case 'rejected': return '#FF3B30';
      case 'under_review': return '#FF9500';
      case 'pending': return '#007AFF';
      default: return '#AAB8C2';
    }
  }

  function getStatusIcon(status: KYCStatus): keyof typeof Ionicons.glyphMap {
    switch (status) {
      case 'approved': return 'checkmark-circle';
      case 'rejected': return 'close-circle';
      case 'under_review': return 'time';
      case 'pending': return 'hourglass';
      default: return 'help-circle';
    }
  }

  function getStatusText(status: KYCStatus): string {
    switch (status) {
      case 'approved': return 'Verified';
      case 'rejected': return 'Rejected';
      case 'under_review': return 'Under Review';
      case 'pending': return 'Pending';
      case 'not_started': return 'Not Started';
    }
  }

  function getDocumentTypeLabel(type: KYCDocument['type']): string {
    switch (type) {
      case 'id_card': return 'National ID Card';
      case 'passport': return 'Passport';
      case 'drivers_license': return 'Driver\'s License';
      case 'proof_of_address': return 'Proof of Address';
    }
  }

  function getDocumentTypeIcon(type: KYCDocument['type']): keyof typeof Ionicons.glyphMap {
    switch (type) {
      case 'id_card': return 'card';
      case 'passport': return 'airplane';
      case 'drivers_license': return 'car';
      case 'proof_of_address': return 'home';
    }
  }

  const documentTypes: KYCDocument['type'][] = ['id_card', 'passport', 'drivers_license', 'proof_of_address'];

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <ActivityIndicator size="large" color="#007AFF" />
      </View>
    );
  }

  return (
    <ScrollView style={styles.container}>
      <View style={styles.header}>
        <Ionicons name="shield-checkmark" size={48} color={getStatusColor(kycStatus)} />
        <Text style={styles.title}>Identity Verification</Text>
        <View style={[styles.statusBadge, { backgroundColor: getStatusColor(kycStatus) + '20' }]}>
          <Ionicons name={getStatusIcon(kycStatus)} size={20} color={getStatusColor(kycStatus)} />
          <Text style={[styles.statusText, { color: getStatusColor(kycStatus) }]}>
            {getStatusText(kycStatus)}
          </Text>
        </View>
      </View>

      {kycStatus === 'approved' && (
        <View style={styles.successCard}>
          <Ionicons name="checkmark-circle" size={32} color="#34C759" />
          <View style={styles.successContent}>
            <Text style={styles.successTitle}>Verification Complete</Text>
            <Text style={styles.successText}>
              Your identity has been verified. You now have full access to all features.
            </Text>
          </View>
        </View>
      )}

      {kycStatus === 'rejected' && (
        <View style={styles.errorCard}>
          <Ionicons name="close-circle" size={32} color="#FF3B30" />
          <View style={styles.errorContent}>
            <Text style={styles.errorTitle}>Verification Declined</Text>
            <Text style={styles.errorText}>
              We couldn't verify your documents. Please upload clearer photos and ensure all information is visible.
            </Text>
            <TouchableOpacity style={styles.retryButton} onPress={loadKYCStatus}>
              <Text style={styles.retryButtonText}>Try Again</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {kycStatus === 'under_review' && (
        <View style={styles.infoCard}>
          <Ionicons name="time" size={32} color="#FF9500" />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>Review in Progress</Text>
            <Text style={styles.infoText}>
              Our team is reviewing your documents. You'll receive a notification within 1-2 business days.
            </Text>
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Required Documents</Text>
        <Text style={styles.sectionSubtitle}>
          Upload at least one government-issued ID and proof of address
        </Text>

        {documentTypes.map((type) => {
          const doc = documents.find(d => d.type === type);
          const hasDoc = !!doc;
          
          return (
            <View key={type} style={styles.documentCard}>
              <View style={styles.documentIcon}>
                <Ionicons name={getDocumentTypeIcon(type)} size={24} color="#007AFF" />
              </View>

              <View style={styles.documentInfo}>
                <Text style={styles.documentName}>{getDocumentTypeLabel(type)}</Text>
                {hasDoc ? (
                  <View style={styles.uploadedStatus}>
                    <Ionicons 
                      name={getStatusIcon(doc.status)} 
                      size={16} 
                      color={getStatusColor(doc.status)} 
                    />
                    <Text style={[styles.uploadedText, { color: getStatusColor(doc.status) }]}>
                      {getStatusText(doc.status)}
                    </Text>
                  </View>
                ) : (
                  <Text style={styles.notUploadedText}>Not uploaded</Text>
                )}
              </View>

              {hasDoc && doc.status === 'rejected' && doc.rejectionReason && (
                <View style={styles.rejectionNote}>
                  <Text style={styles.rejectionText}>{doc.rejectionReason}</Text>
                </View>
              )}

              <TouchableOpacity
                style={[
                  styles.uploadButton,
                  hasDoc && doc.status !== 'rejected' && styles.uploadButtonDisabled
                ]}
                onPress={() => handleUploadDocument(type)}
                disabled={uploading || (hasDoc && doc.status !== 'rejected')}
              >
                <Ionicons 
                  name={hasDoc && doc.status !== 'rejected' ? 'checkmark' : 'cloud-upload'} 
                  size={20} 
                  color={hasDoc && doc.status !== 'rejected' ? '#34C759' : '#FFFFFF'}
                />
              </TouchableOpacity>
            </View>
          );
        })}
      </View>

      <View style={styles.benefitsCard}>
        <Text style={styles.benefitsTitle}>Benefits of Verification</Text>
        <View style={styles.benefit}>
          <Ionicons name="arrow-up-circle" size={20} color="#34C759" />
          <Text style={styles.benefitText}>Higher transaction limits ($50,000+)</Text>
        </View>
        <View style={styles.benefit}>
          <Ionicons name="flash" size={20} color="#34C759" />
          <Text style={styles.benefitText}>Instant withdrawals</Text>
        </View>
        <View style={styles.benefit}>
          <Ionicons name="shield-checkmark" size={20} color="#34C759" />
          <Text style={styles.benefitText}>Enhanced security features</Text>
        </View>
        <View style={styles.benefit}>
          <Ionicons name="globe" size={20} color="#34C759" />
          <Text style={styles.benefitText}>International transfers</Text>
        </View>
      </View>

      <View style={styles.privacyNote}>
        <Ionicons name="lock-closed" size={16} color="#657786" />
        <Text style={styles.privacyText}>
          Your documents are encrypted and stored securely. We never share your personal information without your consent.
        </Text>
      </View>
    </ScrollView>
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
    marginBottom: 16,
  },
  statusBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 20,
    gap: 6,
  },
  statusText: {
    fontSize: 14,
    fontWeight: '600',
  },
  successCard: {
    flexDirection: 'row',
    backgroundColor: '#F0FAF4',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: '#34C759',
  },
  successContent: {
    flex: 1,
  },
  successTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#34C759',
    marginBottom: 4,
  },
  successText: {
    fontSize: 14,
    color: '#657786',
    lineHeight: 20,
  },
  errorCard: {
    flexDirection: 'row',
    backgroundColor: '#FFF0F0',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: '#FF3B30',
  },
  errorContent: {
    flex: 1,
  },
  errorTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FF3B30',
    marginBottom: 4,
  },
  errorText: {
    fontSize: 14,
    color: '#657786',
    lineHeight: 20,
    marginBottom: 12,
  },
  retryButton: {
    backgroundColor: '#FF3B30',
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  retryButtonText: {
    color: '#FFFFFF',
    fontWeight: '600',
    fontSize: 14,
  },
  infoCard: {
    flexDirection: 'row',
    backgroundColor: '#FFF8E6',
    margin: 16,
    padding: 16,
    borderRadius: 12,
    gap: 12,
    borderWidth: 1,
    borderColor: '#FF9500',
  },
  infoContent: {
    flex: 1,
  },
  infoTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: '#FF9500',
    marginBottom: 4,
  },
  infoText: {
    fontSize: 14,
    color: '#657786',
    lineHeight: 20,
  },
  section: {
    padding: 16,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1C1E21',
    marginBottom: 8,
  },
  sectionSubtitle: {
    fontSize: 14,
    color: '#657786',
    marginBottom: 16,
    lineHeight: 20,
  },
  documentCard: {
    flexDirection: 'row',
    alignItems: 'center',
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
  documentIcon: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: '#F0F7FF',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 12,
  },
  documentInfo: {
    flex: 1,
  },
  documentName: {
    fontSize: 16,
    fontWeight: '600',
    color: '#1C1E21',
    marginBottom: 4,
  },
  uploadedStatus: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  uploadedText: {
    fontSize: 14,
    fontWeight: '500',
  },
  notUploadedText: {
    fontSize: 14,
    color: '#AAB8C2',
  },
  rejectionNote: {
    flex: 1,
    marginLeft: 12,
  },
  rejectionText: {
    fontSize: 12,
    color: '#FF3B30',
    fontStyle: 'italic',
  },
  uploadButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: '#007AFF',
    justifyContent: 'center',
    alignItems: 'center',
  },
  uploadButtonDisabled: {
    backgroundColor: '#F0FAF4',
  },
  benefitsCard: {
    backgroundColor: '#FFFFFF',
    margin: 16,
    padding: 20,
    borderRadius: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 3,
    elevation: 2,
  },
  benefitsTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#1C1E21',
    marginBottom: 16,
  },
  benefit: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 12,
    gap: 12,
  },
  benefitText: {
    fontSize: 15,
    color: '#1C1E21',
  },
  privacyNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    padding: 16,
    marginHorizontal: 16,
    marginBottom: 24,
    gap: 10,
    backgroundColor: '#F0F7FF',
    borderRadius: 8,
  },
  privacyText: {
    flex: 1,
    fontSize: 12,
    color: '#657786',
    lineHeight: 18,
  },
});
