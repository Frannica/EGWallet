# E2E Smoke Test Checklist
## Pre-Release Validation - EG Wallet Mobile

**Purpose**: Ensure all critical features work before production release.  
**When to run**: Before every production build/release.

---

## ✅ Global Protections (Must Verify First)

### 1. Crash Protection
- [ ] **Error Boundary Active**: Force a test crash (set invalid prop) → Should show recovery screen
- [ ] **Sentry Reporting**: Verify crash is logged to Sentry dashboard
- [ ] **App Recovery**: Tap "Try Again" → App should restart without hard crash

### 2. Network Protection
- [ ] **Offline Detection**: Turn airplane mode ON → All screens show offline banner
- [ ] **Offline Actions**: Try to send/request money offline → Clear error message
- [ ] **Reconnection**: Turn airplane mode OFF → Banner disappears, actions work
- [ ] **Timeout Handling**: Simulate slow network → Requests timeout with retry option

### 3. Loading Locks
- [ ] **Send Button**: Tap "Confirm & Send" → Button disables, shows spinner
- [ ] **Request Button**: Create payment request → Button disables during submission
- [ ] **QR Confirm**: Tap "Confirm Payment" on QR screen → Button disables
- [ ] **Withdrawal**: Submit withdrawal → Button disables until response
- [ ] **Double-Click**: Rapidly tap any critical button → Only ONE request sent

---

## 🔐 Authentication & Security

### 4. Login Flow
- [ ] **First Launch**: App shows Login/Register screen
- [ ] **Register**: Create new account → Success message, redirects to wallet
- [ ] **Login**: Enter credentials → Success, shows main wallet
- [ ] **Invalid Login**: Wrong password → Clear error message
- [ ] **Token Refresh**: After 24h → App doesn't log out, token refreshes

### 5. Biometric Lock (if enabled)
- [ ] **Lock Trigger**: Background app → Re-open requires biometric
- [ ] **Face/Touch ID**: Authenticate → Access granted
- [ ] **Fallback**: Cancel biometric → Shows PIN/password option

---

## 💰 Wallet Screen (Main Dashboard)

### 6. Wallet Display
- [ ] **Balance Shows**: Correct currency icon and amount displayed
- [ ] **Currency Picker**: Tap currency dropdown → Shows all currencies (XAF, USD, EUR, GBP, NGN, GHS, ZAR, KES)
- [ ] **Switch Currency**: Select different currency → Balance updates
- [ ] **Payroll Banner**: Shows "Start earning today" with correct CTA

### 7. Navigation - Tabs
- [ ] **All Tab**: Tap → Navigates to Transactions screen (all types)
- [ ] **Payroll Tab**: Tap → Navigates to Transactions screen (filtered to payroll only)
- [ ] **Transfers Tab**: Tap → Navigates to Send screen
- [ ] **Notification Bell**: Tap → Navigates to Settings

### 8. Quick Actions
- [ ] **Send**: Tap Send button → Opens SendScreen
- [ ] **Request**: Tap Request button → Opens RequestScreen
- [ ] **Top Up**: Tap Top Up → Shows coming soon or payment gateway

---

## 📤 Send Money Flow

### 9. Transfer Setup
- [ ] **Source Wallet**: Shows current wallet
- [ ] **Amount Input**: Enter number → Shows in correct currency
- [ ] **Destination Input**: Enter wallet ID → Accepts alphanumeric
- [ ] **Preview Calculation**: Shows amount + 1% fee + total

### 10. Transfer Validation
- [ ] **Empty Amount**: Try to send → Error: "Enter valid amount"
- [ ] **Zero Amount**: Enter 0 → Error: "Enter valid amount"
- [ ] **Empty Wallet ID**: Try to send → Error: "Enter destination wallet ID"
- [ ] **Insufficient Funds**: Send more than balance → Error message

### 11. Transfer Confirmation
- [ ] **Scam Warning**: High amount (e.g., $500+) → Shows scam tips checkbox
- [ ] **Acknowledgement**: Must check "I understand" to proceed
- [ ] **Confirm & Send**: Tap → Shows spinner, button disables
- [ ] **Success**: Shows "Transaction completed successfully!"
- [ ] **Balance Update**: Wallet balance decreases by (amount + fee)
- [ ] **Navigation**: Redirects to Transaction History after success

---

## 💸 Withdrawal Flow

### 12. Withdrawal Setup
- [ ] **Tab Switcher**: Tap "Withdraw" tab → Shows withdrawal form
- [ ] **Method Selector**: Toggle Bank/Mobile → Form updates
- [ ] **Bank Fields**: Shows: Bank name, Account number, Account holder name
- [ ] **Mobile Fields**: Shows: Operator name, Phone number, Account holder name

### 13. Withdrawal Validation
- [ ] **Empty Bank Name**: Submit → Error: "Enter bank name"
- [ ] **Empty Account**: Submit → Error: "Enter account number"
- [ ] **Empty Holder**: Submit → Error: "Enter account holder name"

### 14. Withdrawal Confirmation
- [ ] **Preview**: Shows amount, processing time (1-3 days)
- [ ] **Confirm**: Tap → Button disables, shows spinner
- [ ] **Success**: "Withdrawal request submitted!"
- [ ] **Balance Update**: Wallet balance decreases immediately
- [ ] **Status**: Created withdrawal has "pending" status

---

## 📥 Request Money Flow

### 15. Contact Request
- [ ] **Recipient Input**: Enter contact email/phone
- [ ] **Amount Input**: Enter valid amount
- [ ] **Memo**: Add note (optional)
- [ ] **Create Request**: Tap → Success message
- [ ] **Request List**: New request appears in "Sent Requests" tab

### 16. Employer Request → QR Payment (CRITICAL)
- [ ] **Employer Tab**: Switch to "Employer" tab
- [ ] **Employer Selection**: Shows linked employers with verification badges
- [ ] **Select Employer**: Tap verified employer → Selected state shows
- [ ] **Amount Input**: Enter payroll amount (e.g., 1200)
- [ ] **Send Request**: Tap → Shows confirmation dialog
- [ ] **Confirm**: Tap "Send Request" → **Navigates to QR Payment Screen** ✅

### 17. QR Payment Screen (New - Must Verify All)
- [ ] **Navigation**: Arrives at QR screen from employer request ✅
- [ ] **Header**: Shows "Pay [EmployerName]" in blue gradient ✅
- [ ] **Amount Display**: Shows formatted amount (e.g., "$1,200 USD") ✅
- [ ] **QR Code**: Displays 220x220 QR code on white background ✅
- [ ] **QR Data**: Scan QR → Contains: employerId, amount, currency, requestId, timestamp ✅
- [ ] **Employer Details**: Shows employer name with green verified badge ✅
- [ ] **Batch ID**: Displays batch/period information ✅
- [ ] **Secure Badge**: Shows "Secure & Verified" indicator ✅

### 18. QR Payment - Idempotency Protection (CRITICAL)
- [ ] **Confirm Button**: Tap "Confirm Payment" → Shows confirmation dialog ✅
- [ ] **Confirm Dialog**: Shows amount and employer name ✅
- [ ] **Success - First Tap**: Tap "Confirm" → Button disables, spinner shows ✅
- [ ] **Processing Lock**: Button stays disabled during API call ✅
- [ ] **Double-Click Protection**: Rapid tap confirm → Only ONE backend call (check logs) ✅
- [ ] **Idempotency Key**: Check network request → Contains unique "Idempotency-Key" header ✅

### 19. QR Payment - Success Flow
- [ ] **Success Screen**: After confirmation → Shows green checkmark ✅
- [ ] **Receipt Display**: Shows all details (amount, employer, batch, transaction ID, date) ✅
- [ ] **Verified Badge**: Shows on receipt if employer is verified ✅
- [ ] **Done Button**: Tap "Done" → Returns to Main wallet screen ✅
- [ ] **Balance Update**: Wallet balance increases by payment amount ✅
- [ ] **Transaction History**: Payment appears in "Payroll" filter ✅

### 20. QR Payment - Error Handling (CRITICAL)
- [ ] **Offline Test**: Turn airplane mode ON → Tap Confirm ✅
- [ ] **Offline Error**: Shows red alert screen with connection icon
- [ ] **Error Message**: "No internet connection. Please check your network and try again." ✅
- [ ] **Retry Button**: Tap "Try Again" → Resets to QR screen, can retry ✅
- [ ] **Cancel Button**: Tap "Cancel" → Returns to previous screen ✅
- [ ] **Timeout Test**: Simulate slow network (10+ seconds)
- [ ] **Timeout Error**: Shows "Request timed out..." with retry option ✅
- [ ] **Retry Preserves**: Retry uses SAME idempotency key (no duplicate charge) ✅

---

## 💳 Virtual Card

### 21. Card Creation
- [ ] **New Card**: Tap "Create Virtual Card"
- [ ] **Card Details**: Shows card number, CVV, expiry
- [ ] **Copy to Clipboard**: Tap card number → Copied message

### 22. Card Management
- [ ] **Freeze Card**: Toggle freeze → Card status updates
- [ ] **Spending Limits**: Set limit → Saves successfully

---

## 📊 Budget Tracking

### 23. Budget Setup
- [ ] **Create Budget**: Add new category (e.g., Food)
- [ ] **Set Amount**: Enter budget limit (e.g., $500)
- [ ] **Save**: Budget appears in list

### 24. Budget Monitoring
- [ ] **Spending Progress**: Shows % used (e.g., "75% spent")
- [ ] **Over Budget**: Spend more than limit → Shows red warning
- [ ] **Reset**: Monthly reset works correctly

---

## 📜 Transaction History

### 25. Transaction Display
- [ ] **All Transactions**: Shows all types (send, receive, payroll, withdrawal)
- [ ] **Payroll Filter**: Shows only employer payments
- [ ] **Transaction Details**: Tap transaction → Shows full details
- [ ] **Search**: Search by amount/recipient → Filters correctly

---

## 🤖 AI Chat Assistant

### 26. AI Functionality
- [ ] **Open Chat**: Tap AI icon → Opens chat screen
- [ ] **Send Message**: Type question → AI responds
- [ ] **Financial Advice**: Ask about budgeting → Relevant response

---

## 🔐 KYC Verification

### 27. Identity Verification
- [ ] **Start KYC**: Navigate to KYC screen
- [ ] **Upload Document**: Select photo → Upload successful
- [ ] **Submit**: Form submission works

---

## ⚙️ Settings & Security

### 28. Settings Access
- [ ] **Notification Bell**: Tap → Opens settings
- [ ] **Profile**: Shows user info
- [ ] **Security**: Change password option

### 29. Help & Support
- [ ] **Help Center**: Opens help articles
- [ ] **Report Problem**: Fraud reporting works
- [ ] **Dispute Transaction**: Form submission successful

---

## 🚨 Backend Health & Fallback

### 30. Backend Validation
- [ ] **Health Endpoint**: Call `/health` → Returns "OK" (200)
- [ ] **API Response Time**: All endpoints respond < 3 seconds
- [ ] **500 Error**: Simulate backend error → App shows graceful error, doesn't crash
- [ ] **Retry Logic**: Failed request → Auto-retries 2x before showing error

---

## 📊 Production Metrics (Post-Release)

### 31. Sentry Dashboard
- [ ] **Zero Hard Crashes**: No unhandled exceptions in production
- [ ] **Error Rate**: < 1% of sessions have errors
- [ ] **Performance**: P95 load time < 2 seconds

### 32. User Feedback
- [ ] **App Store Reviews**: No complaints about crashes/freezes
- [ ] **Support Tickets**: No critical bugs reported

---

## ✅ Sign-Off

**Tested By**: ___________________  
**Date**: ___________________  
**Build Version**: v1.1.0 (Build 13)  
**Device**: ___________________  
**OS Version**: ___________________  

**Overall Status**:  
- [ ] ✅ All critical tests passed - READY FOR PRODUCTION
- [ ] ⚠️ Minor issues found (document below) - PROCEED WITH CAUTION
- [ ] ❌ Critical issues found - DO NOT RELEASE

**Notes**:
```
[Add any issues, bugs, or observations here]
```

---

## 🔥 Critical Go/No-Go Criteria

**MUST PASS (Blockers)**:
1. ✅ Error boundary catches crashes (no hard crashes)
2. ✅ QR Payment flow works end-to-end
3. ✅ Idempotency prevents double charges
4. ✅ All buttons have loading locks
5. ✅ Offline mode shows proper errors
6. ✅ Send money completes successfully
7. ✅ Withdrawal submits successfully
8. ✅ Backend health check passes

**If ANY blocker fails → DO NOT RELEASE**
