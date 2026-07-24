export type PaymentSheetFlowResult =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

// Method-shorthand syntax (not arrow-function property syntax) is deliberate:
// it gives this duck-typed interface TypeScript's bivariant parameter checking,
// so the real @stripe/stripe-react-native `useStripe()` return value (whose
// initPaymentSheet takes a specific SetupParams, not unknown) remains
// assignable here. This is a pure type-level shape for testability — it
// does not change what gets called or passed at runtime.
type StripeLike = {
  initPaymentSheet(params: unknown): Promise<{ error?: { message: string } }>;
  presentPaymentSheet(): Promise<{ error?: { code?: string; message: string } }>;
};

const paymentSheetInFlight = new Map<string, Promise<PaymentSheetFlowResult>>();

/**
 * Init + present PaymentSheet at most once per clientSecret.
 * Concurrent callers await the same in-flight promise instead of opening another sheet.
 */
export async function runCardOnlyPaymentSheetOnce(
  stripe: StripeLike,
  clientSecret: string,
  setupParams: unknown,
): Promise<PaymentSheetFlowResult> {
  const existing = paymentSheetInFlight.get(clientSecret);
  if (existing) return existing;

  const flow = (async (): Promise<PaymentSheetFlowResult> => {
    const { error: initError } = await stripe.initPaymentSheet(setupParams);
    if (initError) return { status: 'failed', message: initError.message };

    const { error: presentError } = await stripe.presentPaymentSheet();
    if (presentError) {
      return presentError.code === 'Canceled'
        ? { status: 'cancelled' }
        : { status: 'failed', message: presentError.message };
    }
    return { status: 'success' };
  })();

  paymentSheetInFlight.set(clientSecret, flow);
  try {
    return await flow;
  } finally {
    paymentSheetInFlight.delete(clientSecret);
  }
}

/** @internal test hook */
export function _resetPaymentSheetInFlightForTests() {
  paymentSheetInFlight.clear();
}
