import { NativeModules, TurboModuleRegistry } from 'react-native';
import {
  StripeProvider,
  useStripe,
  LinkDisplay,
  type PaymentSheet,
} from '@stripe/stripe-react-native';

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

/**
 * Card-only PaymentSheet defaults. Centralized so release bundles always include
 * the native bridge keys (allowsDelayedPaymentMethods, link.display, paymentMethodOrder).
 */
export const CARD_ONLY_PAYMENT_SHEET_OPTIONS: Pick<
  PaymentSheet.SetupParams,
  'allowsDelayedPaymentMethods' | 'link' | 'paymentMethodOrder'
> = {
  allowsDelayedPaymentMethods: false,
  link: { display: LinkDisplay.NEVER },
  paymentMethodOrder: ['card'],
};

export function buildCardOnlyPaymentSheetParams(
  paymentIntentClientSecret: string,
  merchantDisplayName = 'EGWallet',
): PaymentSheet.SetupParams {
  return {
    paymentIntentClientSecret,
    merchantDisplayName,
    ...CARD_ONLY_PAYMENT_SHEET_OPTIONS,
  };
}

import {
  runCardOnlyPaymentSheetOnce,
  type PaymentSheetFlowResult,
} from './paymentSheetSingleFlight';

export type { PaymentSheetFlowResult };

export function runDepositPaymentSheetOnce(
  stripe: Parameters<typeof runCardOnlyPaymentSheetOnce>[0],
  clientSecret: string,
  merchantDisplayName = 'EGWallet',
): Promise<PaymentSheetFlowResult> {
  return runCardOnlyPaymentSheetOnce(
    stripe,
    clientSecret,
    buildCardOnlyPaymentSheetParams(clientSecret, merchantDisplayName),
  );
}

export { StripeProvider, useStripe, LinkDisplay };
