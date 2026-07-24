/**
 * EGWallet Fee Schedule — single source of truth for all client-side labels.
 *
 * Actual fee calculation is always enforced by the backend.
 * These constants are used only for UI display and informational text.
 */

// ── Rate constants (mirrors backend FEES object) ────────────────────────────
export const TOPUP_FREE_LIMIT    = 6;       // first N top-ups are free
export const TOPUP_FEE_RATE      = 0.005;   // 0.5% after free limit
export const WITHDRAW_LOCAL_RATE = 0.0128;  // 1.28% local withdrawal
export const WITHDRAW_INTL_RATE  = 0.0175;  // 1.75% international withdrawal
export const FX_CONVERSION_RATE  = 0.0115;  // 1.15% on every FX conversion
export const SEND_FEE_RATE       = 0;       // peer-to-peer sends are FREE

// ── Display labels ───────────────────────────────────────────────────────────
export const TRANSFER_FEE_RATE  = SEND_FEE_RATE;         // kept for import compat
export const TRANSFER_FEE_LABEL_KEY = 'fees.sendReceiveType';
export const TRANSFER_FEE_PCT_KEY   = 'fees.free';

/**
 * Full fee schedule — used in About screen, KYC disclosure, AI chat, etc.
 * `type`/`fee`/`note` are i18n keys (see src/i18n/translations.ts, 'fees.*'),
 * translated at render time via t() so the schedule displays in the user's
 * selected language.
 */
export const FEE_SCHEDULE = [
  {
    type: 'fees.addMoneyFreeType',
    fee: 'fees.free',
    note: 'fees.addMoneyFreeNote',
  },
  {
    type: 'fees.addMoneyPaidType',
    fee: 'fees.addMoneyPaidFee',
    note: 'fees.addMoneyPaidNote',
  },
  {
    type: 'fees.sendReceiveType',
    fee: 'fees.free',
    note: 'fees.sendReceiveNote',
  },
  {
    type: 'fees.fxConversionType',
    fee: 'fees.fxConversionFee',
    note: 'fees.fxConversionNote',
  },
  {
    type: 'fees.localWithdrawalType',
    fee: 'fees.localWithdrawalFee',
    note: 'fees.localWithdrawalNote',
  },
  {
    type: 'fees.intlWithdrawalType',
    fee: 'fees.intlWithdrawalFee',
    note: 'fees.intlWithdrawalNote',
  },
  {
    type: 'fees.virtualCardType',
    fee: 'fees.free',
    note: 'fees.virtualCardNote',
  },
  {
    type: 'fees.monthlySubType',
    fee: 'fees.free',
    note: 'fees.monthlySubNote',
  },
] as const;

