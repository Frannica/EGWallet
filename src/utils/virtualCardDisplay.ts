/** Fields returned by GET /virtual-cards after backend sanitizeCard(). */
export type VirtualCardDisplayFields = {
  cardNumber?: string;
  last4?: string;
  maskedNumber?: string;
};

/**
 * Formats a card PAN for display. Never throws — safe for sanitized API payloads
 * that omit cardNumber and only include last4 / maskedNumber.
 */
export function formatMaskedCardNumber(card: VirtualCardDisplayFields | string): string {
  if (typeof card === 'string') {
    const digits = card.replace(/\s/g, '');
    const last4 = digits.length >= 4 ? digits.slice(-4) : '****';
    return `**** **** **** ${last4}`;
  }

  const last4 =
    (card.last4 ? card.last4.slice(-4) : null) ||
    (card.cardNumber && card.cardNumber.replace(/\s/g, '').length >= 4
      ? card.cardNumber.replace(/\s/g, '').slice(-4)
      : null) ||
    (card.maskedNumber && card.maskedNumber.length >= 4 ? card.maskedNumber.slice(-4) : null) ||
    '****';

  return `**** **** **** ${last4}`;
}

/** Ensures list/detail render paths never receive undefined PAN fields. */
export function formatCardExpiry(expiryMonth?: string, expiryYear?: string): string {
  const month = expiryMonth?.trim() || '--';
  const year = expiryYear?.trim() || '--';
  return `${month}/${year}`;
}
