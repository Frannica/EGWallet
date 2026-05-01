
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { View, Text, ActivityIndicator } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import AuthScreen from '../screens/AuthScreen';
import WalletScreen from '../screens/WalletScreen';
import PayScreen from '../screens/PayScreen';
import SendScreen from '../screens/SendScreen';
import RequestScreen from '../screens/RequestScreen';
import CardScreen from '../screens/CardScreen';
import BudgetScreen from '../screens/BudgetScreen';
import SettingsScreen from '../screens/SettingsScreen';
import TransactionHistory from '../screens/TransactionHistory';
import AboutScreen from '../screens/AboutScreen';
import HelpCenterScreen from '../screens/HelpCenterScreen';
import ReportProblemScreen from '../screens/ReportProblemScreen';
import TrustedDevicesScreen from '../screens/TrustedDevicesScreen';
import KYCVerificationScreen from '../screens/KYCVerificationScreen';
import AIChatScreen from '../screens/AIChatScreen';
import DisputeTransactionScreen from '../screens/DisputeTransactionScreen';
import QRPaymentScreen from '../screens/QRPaymentScreen';
import EmployerDashboardScreen from '../screens/EmployerDashboardScreen';
import DepositScreen from '../screens/DepositScreen';
import ReceiptScreen from '../screens/ReceiptScreen';
import NotificationsScreen from '../screens/NotificationsScreen';
import PayRequestScreen from '../screens/PayRequestScreen';
import QRScannerScreen from '../screens/QRScannerScreen';
import { ToastProvider } from '../utils/toast';
import { LinkingOptions } from '@react-navigation/native';
import { useLanguage } from '../i18n/LanguageContext';

const linking: LinkingOptions<any> = {
  prefixes: ['egwallet://'],
  config: {
    screens: {
      PayRequest: 'pay/:requestId',
    },
  },
};

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function Tabs() {
  const { t } = useLanguage();
  return (
    <Tab.Navigator 
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap;

          if (route.name === 'Wallet') {
            iconName = focused ? 'wallet' : 'wallet-outline';
          } else if (route.name === 'Pay') {
            iconName = focused ? 'swap-horizontal' : 'swap-horizontal-outline';
          } else if (route.name === 'Card') {
            iconName = focused ? 'card' : 'card-outline';
          } else if (route.name === 'Budget') {
            iconName = focused ? 'pie-chart' : 'pie-chart-outline';
          } else if (route.name === 'Settings') {
            iconName = focused ? 'settings' : 'settings-outline';
          } else {
            iconName = 'ellipse';
          }

          return <Ionicons name={iconName} size={size} color={color} />;
        },
        tabBarActiveTintColor: '#1565C0',
        tabBarInactiveTintColor: '#9BAEC8',
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopWidth: 0,
          paddingBottom: 10,
          paddingTop: 8,
          height: 72,
          shadowColor: '#1565C0',
          shadowOffset: { width: 0, height: -4 },
          shadowOpacity: 0.08,
          shadowRadius: 16,
          elevation: 20,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '700',
          letterSpacing: 0.2,
        },
        headerStyle: {
          backgroundColor: '#FFFFFF',
          elevation: 0,
          shadowOpacity: 0,
        },
        headerTitleStyle: {
          fontWeight: '800',
          fontSize: 18,
          color: '#0D1B2E',
          letterSpacing: -0.3,
        },
      })}
    >
      <Tab.Screen name="Wallet" component={WalletScreen} options={{ tabBarLabel: t('nav.wallet'), title: t('nav.wallet') }} />
      <Tab.Screen name="Pay" component={PayScreen} options={{ tabBarLabel: t('nav.pay'), title: t('nav.pay') }} />
      <Tab.Screen name="Card" component={CardScreen} options={{ tabBarLabel: t('nav.card'), title: t('nav.card') }} />
      <Tab.Screen name="Budget" component={BudgetScreen} options={{ tabBarLabel: t('nav.budget'), title: t('nav.budget') }} />
      <Tab.Screen name="Settings" component={SettingsScreen} options={{ tabBarLabel: t('nav.settings'), title: t('nav.settings') }} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  const auth = useAuth();
  const { t } = useLanguage();

  // Show spinner while restoring token from SecureStore
  if (auth.loading) {
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#fff' }}>
        <ActivityIndicator size="large" color="#1565C0" />
      </View>
    );
  }

  try {
    return (
      <ToastProvider>
      <NavigationContainer
        linking={linking}
        fallback={
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Text>Loading...</Text>
          </View>
        }
      >
        <Stack.Navigator screenOptions={{ headerShown: true }}>
          {!auth.token ? (
            // ── Not authenticated ── show login/register
            <Stack.Screen name="Auth" component={AuthScreen} options={{ headerShown: false }} />
          ) : (
            // ── Authenticated ── show full app
            <>
              <Stack.Screen name="Main" component={Tabs} options={{ headerShown: false }} />
              <Stack.Screen name="Transactions" component={TransactionHistory} options={{ title: t('screen.transactions') }} />
              <Stack.Screen name="About" component={AboutScreen} options={{ title: t('screen.about') }} />
              <Stack.Screen name="HelpCenter" component={HelpCenterScreen} options={{ title: t('screen.helpCenter') }} />
              <Stack.Screen name="ReportProblem" component={ReportProblemScreen} options={{ title: t('screen.reportProblem') }} />
              <Stack.Screen name="TrustedDevices" component={TrustedDevicesScreen} options={{ title: t('screen.trustedDevices') }} />
              <Stack.Screen name="KYCVerification" component={KYCVerificationScreen} options={{ title: t('screen.kyc') }} />
              <Stack.Screen name="AIChat" component={AIChatScreen} options={{ title: t('screen.aiAssistant') }} />
              <Stack.Screen name="DisputeTransaction" component={DisputeTransactionScreen} options={{ title: 'Dispute Transaction' }} />
              <Stack.Screen name="QRPayment" component={QRPaymentScreen} options={{ title: 'QR Payment' }} />
              <Stack.Screen name="EmployerDashboard" component={EmployerDashboardScreen} options={{ title: t('screen.employerDashboard') }} />
              <Stack.Screen name="Send" component={SendScreen} options={{ title: t('screen.sendMoney') }} />
              <Stack.Screen name="Request" component={RequestScreen} options={{ title: t('screen.requestMoney') }} />
              <Stack.Screen name="Deposit" component={DepositScreen} options={{ title: t('screen.addMoney') }} />
              <Stack.Screen name="Receipt" component={ReceiptScreen} options={{ headerShown: false }} />
              <Stack.Screen name="Notifications" component={NotificationsScreen} options={{ title: t('screen.notifications') }} />
              <Stack.Screen name="PayRequest" component={PayRequestScreen} options={{ title: 'Pay Request' }} />
              <Stack.Screen name="QRScanner" component={QRScannerScreen} options={{ headerShown: false }} />
            </>
          )}
        </Stack.Navigator>
      </NavigationContainer>
      </ToastProvider>
    );
  } catch (error) {
    console.error('AppNavigator render error:', error);
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20, backgroundColor: '#F5F9FF' }}>
        <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#1565C0', marginBottom: 12 }}>
          EGWallet
        </Text>
        <Text style={{ fontSize: 14, color: '#666', textAlign: 'center' }}>
          Starting up... please wait a moment.
        </Text>
      </View>
    );
  }
}
