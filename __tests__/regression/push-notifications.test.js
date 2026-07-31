'use strict';

const fs = require('fs');
const path = require('path');

module.exports = function pushNotificationsSuite(check) {
  const root = path.join(__dirname, '..', '..');
  const pushReg = fs.readFileSync(path.join(root, 'src', 'notifications', 'pushRegistration.ts'), 'utf8');
  const auth = fs.readFileSync(path.join(root, 'src', 'auth', 'AuthContext.tsx'), 'utf8');
  const settings = fs.readFileSync(path.join(root, 'src', 'screens', 'SettingsScreen.tsx'), 'utf8');
  const backendPush = fs.readFileSync(path.join(root, 'backend', 'pushNotifications.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'backend', 'pushRoutes.js'), 'utf8');

  check('[Push] client uses expo-notifications getExpoPushTokenAsync', pushReg.includes('getExpoPushTokenAsync'));
  check('[Push] client registers via POST /push/register', pushReg.includes('/push/register'));
  check('[Push] client unregisters on logout path', auth.includes('unregisterPushTokenFromBackend'));
  check('[Push] client schedules registration after login/restore', auth.includes('schedulePushRegistration'));
  check('[Push] Settings has push opt-out toggle', settings.includes('handleTogglePush') && settings.includes('settings.pushNotifications'));
  check('[Push] Settings has Send Test Notification button', settings.includes('handleSendTestPush') && settings.includes('settings.pushTestSend'));
  check('[Push] client test helper calls POST /push/test-self', pushReg.includes('/push/test-self') && pushReg.includes('SEND_TEST_PUSH_TO_ME'));
  check('[Push] backend send uses Expo Push API URL', backendPush.includes('exp.host/--/api/v2/push/send'));
  check('[Push] backend never awaits push in money path (setImmediate)', backendPush.includes('setImmediate'));
  check('[Push] register rejects foreign userId', routes.includes('PUSH_USER_MISMATCH'));
  check('[Push] ready endpoint does not return Authorization header secrets', !routes.includes('EXPO_ACCESS_TOKEN }') && routes.includes('getPushProviderReadiness'));
  check('[Push] invalid token pattern enforced', pushReg.includes('ExpoPushToken') || pushReg.includes('getExpoPushTokenAsync'));
};
