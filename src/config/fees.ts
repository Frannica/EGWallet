/**
 * EGWallet Fee Schedule — single source of truth for all client-side labels.
 *
 * Actual fee calculation is always enforced by the backend.
 * These constants are used only for UI display and informational text.
 */

// ── Rate constants (mirrors backend FEES object) ────────────────────────────
export const TOPUP_FREE_LIMIT    = 6;       // first N top-ups are free
export const TOPUP_FEE_RATE      = 0.005;   // 0.5% after free limit
export const WITHDRAW_LOCAL_RATE = 0.008;   // 0.8% local withdrawal
export const WITHDRAW_INTL_RATE  = 0.0175;  // 1.75% international withdrawal
export const FX_CONVERSION_RATE  = 0.0115;  // 1.15% on every FX conversion
export const SEND_FEE_RATE       = 0;       // peer-to-peer sends are FREE

// ── Display labels ───────────────────────────────────────────────────────────
export const TRANSFER_FEE_RATE  = SEND_FEE_RATE;         // kept for import compat
export const TRANSFER_FEE_LABEL = 'Transfer Fee';
export const TRANSFER_FEE_PCT   = 'Free';

/**
 * Full fee schedule — used in About screen, KYC disclosure, AI chat, etc.
 */
export const FEE_SCHEDULE = [
  {
    type: 'Add Money (first 6 top-ups)',
    fee: 'Free',
    note: 'No charge on your first 6 deposits',
  },
  {
    type: 'Add Money (after 6 top-ups)',
    fee: '0.5%',
    note: 'Small fee to sustain the service',
  },
  {
    type: 'Send / Receive',
    fee: 'Free',
    note: 'Wallet-to-wallet transfers are always free',
  },
  {
    type: 'FX Conversion',
    fee: '1.15%',
    note: 'Applied when sending across currencies',
  },
  {
    type: 'Local Withdrawal',
    fee: '0.8%',
    note: 'Withdraw to local bank or mobile money',
  },
  {
    type: 'International Withdrawal',
    fee: '1.75%',
    note: 'Withdraw to overseas bank account',
  },
  {
    type: 'Virtual / Prepaid Card',
    fee: 'Free',
    note: 'Issuance and usage are free',
  },
  {
    type: 'Monthly Subscription',
    fee: 'Free',
    note: 'No recurring or hidden charges',
  },
] as const;
