
import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { View, Text } from 'react-native';
import WalletScreen from '../screens/WalletScreen';
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

const Tab = createBottomTabNavigator();
const Stack = createNativeStackNavigator();

function Tabs() {
  return (
    <Tab.Navigator 
      screenOptions={({ route }) => ({
        headerShown: true,
        tabBarIcon: ({ focused, color, size }) => {
          let iconName: keyof typeof Ionicons.glyphMap;

          if (route.name === 'Wallet') {
            iconName = focused ? 'wallet' : 'wallet-outline';
          } else if (route.name === 'Send') {
            iconName = focused ? 'send' : 'send-outline';
          } else if (route.name === 'Request') {
            iconName = focused ? 'download' : 'download-outline';
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
        tabBarActiveTintColor: '#007AFF',
        tabBarInactiveTintColor: '#8E8E93',
        tabBarStyle: {
          backgroundColor: '#FFFFFF',
          borderTopWidth: 1,
          borderTopColor: '#E1E8ED',
          paddingBottom: 4,
          paddingTop: 4,
          height: 60,
        },
        tabBarLabelStyle: {
          fontSize: 11,
          fontWeight: '600',
        },
        headerStyle: {
          backgroundColor: '#FFFFFF',
          elevation: 0,
          shadowOpacity: 0,
          borderBottomWidth: 1,
          borderBottomColor: '#E1E8ED',
        },
        headerTitleStyle: {
          fontWeight: '700',
          fontSize: 18,
        },
      })}
    >
      <Tab.Screen name="Wallet" component={WalletScreen} />
      <Tab.Screen name="Send" component={SendScreen} />
      <Tab.Screen name="Request" component={RequestScreen} />
      <Tab.Screen name="Card" component={CardScreen} />
      <Tab.Screen name="Budget" component={BudgetScreen} />
      <Tab.Screen name="Settings" component={SettingsScreen} />
    </Tab.Navigator>
  );
}

export default function AppNavigator() {
  try {
    return (
      <NavigationContainer
        fallback={
          <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
            <Text>Loading...</Text>
          </View>
        }
      >
        <Stack.Navigator screenOptions={{ headerShown: true }}>
          <Stack.Screen name="Main" component={Tabs} options={{ headerShown: false }} />
          <Stack.Screen name="Transactions" component={TransactionHistory} options={{ title: 'Transactions' }} />
          <Stack.Screen name="About" component={AboutScreen} options={{ title: 'About EGWallet' }} />
          <Stack.Screen name="HelpCenter" component={HelpCenterScreen} options={{ title: 'Help Center' }} />
          <Stack.Screen name="ReportProblem" component={ReportProblemScreen} options={{ title: 'Report Problem' }} />
          <Stack.Screen name="TrustedDevices" component={TrustedDevicesScreen} options={{ title: 'Trusted Devices' }} />
          <Stack.Screen name="KYCVerification" component={KYCVerificationScreen} options={{ title: 'Identity Verification' }} />
          <Stack.Screen name="AIChat" component={AIChatScreen} options={{ title: 'AI Assistant' }} />
          <Stack.Screen name="DisputeTransaction" component={DisputeTransactionScreen} options={{ title: 'Dispute Transaction' }} />
        </Stack.Navigator>
      </NavigationContainer>
    );
  } catch (error) {
    console.error('AppNavigator render error:', error);
    return (
      <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: 20 }}>
        <Text style={{ fontSize: 18, fontWeight: 'bold', color: '#d32f2f', marginBottom: 12 }}>
          ⚠️ Navigation Error
        </Text>
        <Text style={{ fontSize: 14, color: '#666', textAlign: 'center' }}>
          Failed to initialize navigation. Please restart the app.
        </Text>
      </View>
    );
  }
}
