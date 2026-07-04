export type PaymentSheetFlowResult =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'failed'; message: string };

type StripeLike = {
  initPaymentSheet: (params: unknown) => Promise<{ error?: { message: string } }>;
  presentPaymentSheet: () => Promise<{ error?: { code?: string; message: string } }>;
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
