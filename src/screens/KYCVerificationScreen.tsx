import React, { useState, useEffect } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert, ActivityIndicator, Image } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { useAuth } from '../auth/AuthContext';
import { API_BASE } from '../api/client';
import { useLanguage } from '../i18n/LanguageContext';

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
  const { t } = useLanguage();
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

  function getDocumentInstructions(type: KYCDocument['type'], tFn: (key: string) => string): string {
    switch (type) {
      case 'id_card':         return tFn('kyc.idCardInstructions');
      case 'passport':        return tFn('kyc.passportInstructions');
      case 'drivers_license': return tFn('kyc.driversLicenseInstructions');
      case 'proof_of_address': return tFn('kyc.proofOfAddressInstructions');
    }
  }

  async function pickAndUpload(type: KYCDocument['type'], source: 'camera' | 'gallery') {
    // Request permission
    if (source === 'camera') {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(t('kyc.cameraPermission'), t('kyc.cameraPermissionMsg'));
        return;
      }
    } else {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(t('kyc.galleryPermission'), t('kyc.galleryPermissionMsg'));
        return;
      }
    }

    // Launch picker
    const result = source === 'camera'
      ? await ImagePicker.launchCameraAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: true,
          aspect: [4, 3],
          quality: 0.85,
        })
      : await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          allowsEditing: true,
          aspect: [4, 3],
          quality: 0.85,
        });

    if (result.canceled || !result.assets?.[0]) return;

    const asset = result.assets[0];

    // ── Security: allowlist document types ───────────────────────────────────
    const ALLOWED_DOC_TYPES: KYCDocument['type'][] = ['id_card', 'passport', 'drivers_license', 'proof_of_address'];
    if (!ALLOWED_DOC_TYPES.includes(type)) {
      Alert.alert(t('kyc.invalidDocType'), t('kyc.invalidDocTypeMsg'));
      return;
    }

    // ── Security: allowlist MIME types (images only) ──────────────────────────
    const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    const mimeType = asset.mimeType?.toLowerCase() ?? 'image/jpeg';
    if (!ALLOWED_MIME.includes(mimeType)) {
      Alert.alert(t('kyc.invalidFileType'), t('kyc.invalidFileTypeMsg'));
      return;
    }

    // ── Security: validate URI is a local file (not a remote URL) ────────────
    if (!asset.uri || (!asset.uri.startsWith('file://') && !asset.uri.startsWith('content://'))) {
      Alert.alert(t('kyc.invalidImage'), t('kyc.invalidImageMsg'));
      return;
    }

    // ── Security: file size (max 10 MB) ──────────────────────────────────────
    if (asset.fileSize && asset.fileSize > 10 * 1024 * 1024) {
      Alert.alert(t('kyc.fileTooLarge'), t('kyc.fileTooLargeMsg'));
      return;
    }

    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('document', {
        uri: asset.uri,
        type: mimeType,
        name: `kyc_${type}_${Date.now()}.jpg`,
      } as any);
      // Use validated type from allowlist — never trust raw user input
      formData.append('documentType', type);

      const res = await fetch(`${API_BASE}/kyc/upload`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${auth.token}` },
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as any).error || 'Upload failed');
      }

      const newDoc: KYCDocument = {
        id: Math.random().toString(36).substring(7),
        type,
        status: 'under_review',
        uploadedAt: Date.now(),
      };
      setDocuments(prev => {
        const filtered = prev.filter(d => d.type !== type);
        return [...filtered, newDoc];
      });
      setKycStatus('under_review');
      Alert.alert(t('kyc.documentSubmittedTitle'), t('kyc.documentSubmittedMsg'));
    } catch (error: any) {
      // If backend KYC endpoint not yet live, store locally as pending
      if (error?.message?.includes('fetch') || error?.message?.includes('network') || error?.message?.includes('404')) {
        const newDoc: KYCDocument = {
          id: Math.random().toString(36).substring(7),
          type,
          status: 'under_review',
          uploadedAt: Date.now(),
        };
        setDocuments(prev => {
          const filtered = prev.filter(d => d.type !== type);
          return [...filtered, newDoc];
        });
        setKycStatus('under_review');
        Alert.alert(t('kyc.documentCaptured'), t('kyc.documentCapturedMsg'));
      } else {
        Alert.alert(t('kyc.uploadFailed'), error.message ?? t('common.networkError'));
      }
    } finally {
      setUploading(false);
    }
  }

  async function handleUploadDocument(type: KYCDocument['type']) {
    Alert.alert(
      getDocumentTypeLabel(type),
      getDocumentInstructions(type, t),
      [
        { text: 'Cancel', style: 'cancel' },
        { text: t('kyc.takePhoto'), onPress: () => pickAndUpload(type, 'camera') },
        { text: t('kyc.chooseFromGallery'), onPress: () => pickAndUpload(type, 'gallery') },
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
      case 'approved': return t('kyc.approved');
      case 'rejected': return t('kyc.rejected');
      case 'under_review': return t('kyc.underReview');
      case 'pending': return t('kyc.pending');
      case 'not_started': return t('kyc.notStarted');
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
        <Text style={styles.title}>{t('kyc.title')}</Text>
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
            <Text style={styles.successTitle}>{t('kyc.verificationComplete')}</Text>
            <Text style={styles.successText}>{t('kyc.verificationCompleteText')}</Text>
          </View>
        </View>
      )}

      {kycStatus === 'rejected' && (
        <View style={styles.errorCard}>
          <Ionicons name="close-circle" size={32} color="#FF3B30" />
          <View style={styles.errorContent}>
            <Text style={styles.errorTitle}>{t('kyc.verificationDeclined')}</Text>
            <Text style={styles.errorText}>{t('kyc.verificationDeclinedText')}</Text>
            <TouchableOpacity style={styles.retryButton} onPress={loadKYCStatus}>
              <Text style={styles.retryButtonText}>{t('kyc.tryAgain')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {kycStatus === 'under_review' && (
        <View style={styles.infoCard}>
          <Ionicons name="time" size={32} color="#FF9500" />
          <View style={styles.infoContent}>
            <Text style={styles.infoTitle}>{t('kyc.inReview')}</Text>
            <Text style={styles.infoText}>{t('kyc.inReviewText')}</Text>
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('kyc.requiredDocuments')}</Text>
        <Text style={styles.sectionSubtitle}>{t('kyc.requiredDocsNote')}</Text>

        {documentTypes.map((type) => {
          const doc = documents.find(d => d.type === type);
          const hasDoc = !!doc;
          
          return (
            <View key={type} style={styles.documentCard}>
              <View style={styles.documentIcon}>
                <Ionicons name={getDocumentTypeIcon(type)} size={24} color="#007AFF" />
              </View>

              <View style={styles.documentInfo}>
                <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 4, marginBottom: 2 }}>
                  <Text style={styles.documentName}>{getDocumentTypeLabel(type)}</Text>
                  {type === 'id_card' && (
                    <View style={{ backgroundColor: '#007AFF', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                      <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>{t('kyc.preferred')}</Text>
                    </View>
                  )}
                  {type === 'proof_of_address' && (
                    <View style={{ backgroundColor: '#34C759', borderRadius: 4, paddingHorizontal: 5, paddingVertical: 1 }}>
                      <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>{t('kyc.required')}</Text>
                    </View>
                  )}
                </View>
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
                  <Text style={styles.notUploadedText}>{t('kyc.notUploaded')}</Text>
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
        <Text style={styles.benefitsTitle}>{t('kyc.benefitsTitle')}</Text>
        <View style={styles.benefit}>
          <Ionicons name="arrow-up-circle" size={20} color="#34C759" />
          <Text style={styles.benefitText}>{t('kyc.higherLimits')}</Text>
        </View>
        <View style={styles.benefit}>
          <Ionicons name="flash" size={20} color="#34C759" />
          <Text style={styles.benefitText}>{t('kyc.instantWithdrawals')}</Text>
        </View>
        <View style={styles.benefit}>
          <Ionicons name="shield-checkmark" size={20} color="#34C759" />
          <Text style={styles.benefitText}>{t('kyc.enhancedSecurity')}</Text>
        </View>
        <View style={styles.benefit}>
          <Ionicons name="globe" size={20} color="#34C759" />
          <Text style={styles.benefitText}>{t('kyc.internationalTransfers')}</Text>
        </View>
      </View>

      <View style={styles.privacyNote}>
        <Ionicons name="lock-closed" size={16} color="#657786" />
        <Text style={styles.privacyText}>
          {t('kyc.privacyNote')}
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
