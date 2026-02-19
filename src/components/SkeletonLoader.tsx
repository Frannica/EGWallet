import React, { useEffect, useRef } from 'react';
import { View, StyleSheet, Animated, ViewStyle } from 'react-native';

interface SkeletonProps {
  width?: number | string;
  height?: number;
  borderRadius?: number;
  style?: ViewStyle;
}

export function Skeleton({ width = '100%', height = 20, borderRadius = 4, style }: SkeletonProps) {
  const opacity = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 800,
          useNativeDriver: true,
        }),
      ])
    );
    animation.start();
    return () => animation.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        styles.skeleton,
        style,
        {
          width: width as any,
          height,
          borderRadius,
          opacity,
        },
      ]}
    />
  );
}

export function TransactionCardSkeleton() {
  return (
    <View style={styles.transactionCard}>
      <View style={styles.transactionHeader}>
        <Skeleton width={48} height={48} borderRadius={24} style={{ marginRight: 12 }} />
        <View style={styles.transactionContent}>
          <Skeleton width="60%" height={18} style={{ marginBottom: 8 }} />
          <Skeleton width="40%" height={14} style={{ marginBottom: 8 }} />
          <Skeleton width="80%" height={12} />
        </View>
      </View>
    </View>
  );
}

export function WalletCardSkeleton() {
  return (
    <View style={styles.walletCard}>
      <Skeleton width="50%" height={20} style={{ marginBottom: 12 }} />
      <Skeleton width="70%" height={32} style={{ marginBottom: 8 }} />
      <Skeleton width="40%" height={16} />
    </View>
  );
}

export function PaymentRequestCardSkeleton() {
  return (
    <View style={styles.requestCard}>
      <View style={styles.cardRow}>
        <Skeleton width=" 30%" height={24} />
        <Skeleton width="50%" height={20} />
      </View>
      <Skeleton width="100%" height={16} style={{ marginTop: 12 }} />
      <View style={styles.cardRow}>
        <Skeleton width={80} height={36} borderRadius={8} style={{ marginTop: 12 }} />
        <Skeleton width={80} height={36} borderRadius={8} style={{ marginTop: 12 }} />
      </View>
    </View>
  );
}

export function CardSkeleton() {
  return (
    <View style={styles.virtualCard}>
      <Skeleton width="60%" height={20} style={{ marginBottom: 16 }} />
      <Skeleton width="100%" height={24} style={{ marginBottom: 8 }} />
      <View style={styles.cardRow}>
        <Skeleton width="30%" height={16} />
        <Skeleton width="20%" height={16} />
      </View>
    </View>
  );
}

export function BudgetCardSkeleton() {
  return (
    <View style={styles.budgetCard}>
      <Skeleton width="50%" height={20} style={{ marginBottom: 12 }} />
      <Skeleton width="100%" height={8} borderRadius={4} style={{ marginBottom: 8 }} />
      <View style={styles.cardRow}>
        <Skeleton width="40%" height={16} />
        <Skeleton width="40%" height={16} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  skeleton: {
    backgroundColor: '#E1E8ED',
  },
  transactionCard: {
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
  transactionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  transactionContent: {
    flex: 1,
  },
  walletCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  requestCard: {
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
  virtualCard: {
    backgroundColor: '#FFFFFF',
    borderRadius: 16,
    padding: 20,
    marginBottom: 16,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 3,
  },
  budgetCard: {
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
  cardRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
