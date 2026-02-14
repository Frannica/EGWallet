# Automatic Currency Conversion Feature (with Manual Override)

## Overview

EGWallet supports **automatic currency conversion with optional manual override**. When you send money to anyone worldwide, they can choose to:
- **Auto-convert (default):** Receive in their preferred local currency automatically
- **Manual override:** Receive in the original currency (multi-currency wallet)

## How It Works

### For Senders
1. **Send in any currency** - Choose from 32 supported currencies
2. **Recipient's preference honored** - They receive based on their settings
3. **Real-time exchange rates** - Applied automatically when conversion is enabled

### For Receivers
You have **full control** over how you receive payments:

#### Option 1: Auto-Convert (Default - Recommended)
1. **Set your preferred currency** in Settings
2. **Enable "Auto-Convert Incoming Payments"** toggle
3. **All incoming payments automatically convert** to your chosen currency
4. **Single-currency wallet** - Easier to manage

#### Option 2: Manual Override (Multi-Currency Wallet)
1. **Disable "Auto-Convert Incoming Payments"** in Settings
2. **Receive payments in original currency** sent by sender
3. **Hold multiple currencies** in your wallet simultaneously
4. **Full flexibility** - Keep USD, EUR, XAF, NGN all in one wallet

## Setting Your Preferences

### 1. Set Preferred Currency
1. Open **Settings** screen
2. Under **Account** section, tap on "Preferred Receiving Currency"
3. Select your currency from 32+ supported currencies
4. This currency is used when auto-convert is enabled

### 2. Toggle Auto-Convert
1. Open **Settings** screen
2. Under **Account** section, find "Auto-Convert Incoming Payments"
3. **Toggle ON (Blue):** Receive all payments in your preferred currency
4. **Toggle OFF (Gray):** Receive payments in original currency (multi-currency wallet)

## Use Cases

### Use Case 1: Traveler/Expat (Auto-Convert OFF)
**Scenario:** You travel frequently and need multiple currencies

**Settings:**
- Auto-Convert: **OFF** (disabled)
- Preferred Currency: XAF (doesn't matter when disabled)

**Benefits:**
- Keep USD for US expenses
- Keep EUR for Europe trips
- Keep XAF for local Equatorial Guinea spending
- No forced conversion

### Use Case 2: Local Business (Auto-Convert ON)
**Scenario:** You operate in Equatorial Guinea and only need XAF

**Settings:**
- Auto-Convert: **ON** (enabled)
- Preferred Currency: **XAF**

**Benefits:**
- Always receive XAF regardless of what customers send
- No need to convert manually
- Simpler accounting (single currency)
- Automatic exchange rate handling

## Auto-Detection on Signup

When you create an account, your preferred currency is **automatically detected** based on your region:

| Region | Auto-Detected Currency |
|--------|----------------------|
| Equatorial Guinea (GQ) | XAF (Central African CFA franc) |
| Nigeria (NG) | NGN (Nigerian Naira) |
| Ghana (GH) | GHS (Ghanaian Cedi) |
| South Africa (ZA) | ZAR (South African Rand) |
| Kenya (KE) | KES (Kenyan Shilling) |
| Tanzania (TZ) | TZS (Tanzanian Shilling) |
| Uganda (UG) | UGX (Ugandan Shilling) |
| Rwanda (RW) | RWF (Rwandan Franc) |
| Ethiopia (ET) | ETB (Ethiopian Birr) |
| Egypt (EG) | EGP (Egyptian Pound) |
| And 18 more African countries... | ... |

## Example Transactions

### Example 1: Auto-Convert Enabled
**Receiver Settings:**
- Auto-Convert: **ON**
- Preferred Currency: **XAF**

**Transaction:**
- Sender sends: **$100 USD**
- Exchange rate: 1 USD = 600 XAF
- Receiver gets: **60,000 XAF** (auto-converted)
- Transaction history shows: "Sent $100 USD → Received 60,000 XAF (auto-converted)"

### Example 2: Auto-Convert Disabled (Multi-Currency)
**Receiver Settings:**
- Auto-Convert: **OFF**
- Preferred Currency: XAF (not used)

**Transaction:**
- Sender sends: **$100 USD**
- Exchange rate: N/A (no conversion)
- Receiver gets: **$100 USD** (original currency)
- Transaction history shows: "Sent $100 USD, Received $100 USD (original currency)"

**Result:** Receiver now has both XAF and USD in their wallet

### Example 3: Mixed Wallet
**Receiver Settings:**
- Auto-Convert: **OFF**

**After multiple transactions:**
- Balance 1: 60,000 XAF
- Balance 2: $250 USD
- Balance 3: €100 EUR
- Balance 4: ₦50,000 NGN

**Total value:** Displayed in USD equivalent across all currencies

## Supported Currencies

**28 African Currencies:**
- XAF, NGN, GHS, ZAR, KES, TZS, UGX, RWF, ETB, EGP
- TND, MAD, LYD, DZD, AOA, ERN, SOS, SDG, GMD, MUR
- SCR, BWP, ZWL, MZN, NAD, LSL, XOF, and more

**International Currencies:**
- USD, EUR, GBP, JPY, CAD, BRL, CNY

## Exchange Rate Information

- **Source:** Real-time exchange rates updated regularly
- **Base Currency:** USD (all conversions go through USD)
- **No Conversion Fees:** EGWallet charges **0% markup** on currency conversion
- **Transparent Rates:** Rates shown at time of transaction

## Transaction Limits

Currency conversion respects all existing limits:
- **Daily sending limit:** $5,000 USD equivalent
- **Wallet capacity:** $250,000 USD equivalent
- **Same security:** All conversions are secure and encrypted

## Benefits

✅ **Full Control** - Choose auto-convert or multi-currency wallet
✅ **True Global Payments** - Send to anyone, anywhere, in any currency
✅ **Flexible Receiving** - Auto-convert or keep original currency
✅ **Multi-Currency Support** - Hold 32+ currencies in one wallet
✅ **Regional Optimization** - Default currency based on user's location
✅ **Zero Markup** - No hidden fees on exchange rates
✅ **Real-Time Rates** - Always current exchange rates
✅ **Transparent** - Clear conversion indicators in transaction history
✅ **Easy Toggle** - Switch between modes anytime in Settings

## Technical Details

### Backend Implementation

The backend automatically:
1. Detects receiver's preferred currency from their profile
2. Converts sent amount using current exchange rates
3. Credits receiver's wallet in their preferred currency
4. Records both sent and received amounts in transaction

### Conversion Formula

```
Sent Amount (in sender's currency)
    ↓ Convert to USD
USD Amount = Sent Amount / Exchange Rate (sender currency)
    ↓ Convert to receiver's currency
Received Amount = USD Amount × Exchange Rate (receiver currency)
```

### API Changes

**User Profile:**
```json
{
  "id": "user-123",
  "email": "user@example.com",
  "preferredCurrency": "XAF",
  "autoConvertIncoming": true
}
```

**Transaction Record:**
```json
{
  "id": "tx-456",
  "amount": 10000,
  "currency": "USD",
  "receivedAmount": 6000000,
  "receivedCurrency": "XAF",
  "wasConverted": true,
  "status": "completed"
}
```

**New Endpoint:**
```
POST /auth/update-auto-convert
Body: { "autoConvertIncoming": true }
Response: { "success": true, "autoConvertIncoming": true }
```

## User Experience

### In SendScreen
- Info message: "The receiver will automatically receive this payment in their preferred currency"
- No extra steps needed - just send as normal

### In SettingsScreen
- New "Preferred Receiving Currency" selector
- Shows current currency with symbol
- Easy modal picker with all 32+ currencies
- Clear explanation of what it does

### In TransactionHistory
- Shows sent amount in original currency
- Shows received amount if currency was converted
- Label: "(auto-converted)" for clarity

## Migration Notes

**Existing Users:**
- Default preferred currency: XAF (Equatorial Guinea focus)
- Can change anytime in Settings
- Old transactions without conversion info show as normal

**New Users:**
- Preferred currency auto-detected from region at signup
- Based on device locale or registration region parameter

## Future Enhancements

Potential future features:
- [ ] Multiple preferred currencies with priority order
- [ ] Currency conversion preview before sending
- [ ] Historical exchange rate tracking
- [ ] Conversion fee optimization
- [ ] Batch conversion for multiple transactions

---

**Status:** ✅ Implemented and Ready for Production
**Version:** 1.0.0, Build 2
**Date:** February 3, 2026

