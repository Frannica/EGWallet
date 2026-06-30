import { NativeModules, TurboModuleRegistry } from 'react-native';
import { StripeProvider, useStripe } from '@stripe/stripe-react-native';

/** True when the native Stripe module is linked in this build (EAS/dev client). */
export function isStripeSdkAvailable(): boolean {
  try {
    if (NativeModules.StripeSdk != null) return true;
    return TurboModuleRegistry.get('StripeSdk') != null;
  } catch {
    return false;
  }
}

export const STRIPE_SDK_AVAILABLE = isStripeSdkAvailable();
export { StripeProvider, useStripe };
