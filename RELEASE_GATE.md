# 🚦 RELEASE GATE CHECKLIST
## EG Wallet Mobile - Production Release Validation

**Date**: _____________  
**Build Version**: 1.1.0 (Build 13)  
**Tester**: _____________

---

## ⚠️ CRITICAL RULE
**NO BUILD until ALL checks pass ✅**

If ANY check fails → FIX FIRST, then restart validation.

---

## 1️⃣ Production-Mode Run

**Command**:
```bash
npx expo start --no-dev --minify
```

**What to check**:
- [ ] ✅ Server starts without errors
- [ ] ✅ No red errors in terminal
- [ ] ✅ App loads on device/simulator
- [ ] ✅ No crash on launch

**Status**: ⬜ PASS / ⬜ FAIL  
**Notes**: _________________________________

---

## 2️⃣ Build-Time Bundling Check

**Command**:
```bash
npx expo export --platform android
```

**Success criteria**:
- [ ] ✅ Bundling completes successfully
- [ ] ✅ Shows "Export successful"
- [ ] ✅ No "Transform errors"
- [ ] ✅ No "Module not found"
- [ ] ✅ No TypeScript errors

**❌ IF THIS FAILS → NO BUILD**

**Status**: ⬜ PASS / ⬜ FAIL  
**Errors** (if any): _________________________________

---

## 3️⃣ Zero-Error Rule

### Terminal Check
- [ ] ✅ 0 red errors in terminal
- [ ] ✅ 0 red errors in Metro bundler
- [ ] ✅ 0 red errors on device logs

### Promise Rejection Check
- [ ] ✅ No "Unhandled promise rejection" warnings
- [ ] ✅ All async operations have try/catch
- [ ] ✅ All fetch calls have error handling

**Status**: ⬜ PASS / ⬜ FAIL

---

## 4️⃣ Button Lock + Idempotency (Money Safety)

### Critical Buttons to Verify

#### ✅ Send Screen - "Confirm & Send"
- [ ] Button disables immediately on tap
- [ ] Shows loading spinner during processing
- [ ] Cannot be tapped twice
- [ ] Re-enables only after success/error
- **File**: `src/screens/SendScreen.tsx` line 380

#### ✅ QR Payment - "Confirm Payment"
- [ ] Button disables on tap
- [ ] Shows spinner during API call
- [ ] Idempotency key generated once (persists across retries)
- [ ] Backend checks idempotency key (no double charge)
- [ ] Cannot confirm same payment twice
- **Files**: 
  - Frontend: `src/screens/QRPaymentScreen.tsx` line 27, 284
  - Backend: `backend/index.js` line 4517

#### ✅ Request Screen - "Send Request"
- [ ] Button disables during submission
- [ ] Shows loading state
- [ ] Cannot submit duplicate requests
- **File**: `src/screens/RequestScreen.tsx` line 104

#### ✅ Withdrawal - "Confirm Withdrawal"
- [ ] Button disables on tap
- [ ] Shows loading spinner
- [ ] Cannot submit twice
- **File**: `src/screens/SendScreen.tsx` (withdrawal tab)

**Status**: ⬜ PASS / ⬜ FAIL

---

## 5️⃣ Mandatory Smoke Test (Manual - 3-5 minutes)

### 🏠 Wallet Screen
- [ ] ✅ Wallet balance displays correctly
- [ ] ✅ Currency picker works
- [ ] ✅ Payroll banner shows
- [ ] ✅ **Tab "All"** → Navigates to Transactions (all types)
- [ ] ✅ **Tab "Payroll"** → Navigates to Transactions (payroll filter)
- [ ] ✅ **Tab "Transfers"** → Navigates to Send screen
- [ ] ✅ **Notification bell** → Navigates to Settings
- [ ] ✅ Bottom tab navigation works (Wallet/Send/Request/Card/Budget)

**Test Result**: ⬜ PASS / ⬜ FAIL

---

### 💸 Send Screen
- [ ] ✅ Screen loads without errors
- [ ] ✅ Amount input accepts numbers
- [ ] ✅ Currency selector works
- [ ] ✅ **Validation**: Empty amount → Shows error "Enter valid amount"
- [ ] ✅ **Validation**: Zero amount → Shows error
- [ ] ✅ **Validation**: Empty destination → Shows error "Enter destination wallet ID"
- [ ] ✅ Fee calculation displays (1% fee)
- [ ] ✅ Submit → Shows confirmation dialog
- [ ] ✅ Confirm → Button disables, spinner shows
- [ ] ✅ **No duplicate send**: Rapid tap → Only ONE transaction
- [ ] ✅ Back/forward navigation works
- [ ] ✅ Success → Redirects to Transaction History

**Test Result**: ⬜ PASS / ⬜ FAIL

---

### 💸 Withdrawal (in Send Screen)
- [ ] ✅ Tab switcher shows "Transfer" and "Withdraw"
- [ ] ✅ Tap "Withdraw" → Shows withdrawal form
- [ ] ✅ Method selector: Bank / Mobile Money
- [ ] ✅ Bank fields: Bank name, Account number, Account holder
- [ ] ✅ Validation works (empty fields show errors)
- [ ] ✅ Submit → Shows confirmation
- [ ] ✅ Confirm → Button disables, spinner shows
- [ ] ✅ Success message appears
- [ ] ✅ Balance updates

**Test Result**: ⬜ PASS / ⬜ FAIL

---

### 📥 Request Screen
- [ ] ✅ Screen loads without errors
- [ ] ✅ **Toggle Contact/Employer** tabs work
- [ ] ✅ Contact tab: Recipient input works
- [ ] ✅ Employer tab: Shows linked employers
- [ ] ✅ Employer selection works (checkbox selects)
- [ ] ✅ Verified badge shows for verified employers
- [ ] ✅ Amount input works
- [ ] ✅ Memo/note field accepts text
- [ ] ✅ **Submit request → Navigates to QR Payment screen** ✅ CRITICAL
- [ ] ✅ Back button works

**Test Result**: ⬜ PASS / ⬜ FAIL

---

### 📱 QR Payment Screen
- [ ] ✅ **Navigation**: Arrives from Request (Employer) ✅ CRITICAL
- [ ] ✅ Header shows "Pay [EmployerName]" in blue gradient
- [ ] ✅ **QR shows correct amount** (e.g., "$1,200 USD")
- [ ] ✅ **QR shows correct currency**
- [ ] ✅ **QR shows correct employer name**
- [ ] ✅ QR code displays (220x220, white background)
- [ ] ✅ Employer verification badge shows (if verified)
- [ ] ✅ Batch ID displays
- [ ] ✅ "Secure & Verified" indicator shows
- [ ] ✅ **Tap "Confirm Payment"** → Shows confirmation dialog
- [ ] ✅ Tap "Confirm" in dialog → Button disables, spinner shows
- [ ] ✅ **Confirm works once**: Rapid tap → Only ONE backend call
- [ ] ✅ **Success state shown**: Receipt with transaction details
- [ ] ✅ Transaction ID displayed on receipt
- [ ] ✅ "Done" button → Returns to wallet/previous screen
- [ ] ✅ **Offline test**: Airplane mode ON → Shows error "No internet connection"
- [ ] ✅ Offline error → "Retry" button available
- [ ] ✅ Offline error → "Cancel" button works
- [ ] ✅ **No crash when offline** ✅ CRITICAL

**Test Result**: ⬜ PASS / ⬜ FAIL

---

### 💳 Card Screen
- [ ] ✅ Screen opens without errors
- [ ] ✅ "Create Virtual Card" button works
- [ ] ✅ Card details display (if card exists)
- [ ] ✅ Copy button works
- [ ] ✅ Freeze/unfreeze toggle works

**Test Result**: ⬜ PASS / ⬜ FAIL

---

### 📊 Budget Screen
- [ ] ✅ Screen opens without errors
- [ ] ✅ Budget list displays
- [ ] ✅ "Create Budget" button works
- [ ] ✅ Budget form submits successfully
- [ ] ✅ Progress bars show correct percentage

**Test Result**: ⬜ PASS / ⬜ FAIL

---

## 6️⃣ Backend Health Check

**URL**: https://eg-wallet-backend-production.up.railway.app/health

**Command**:
```bash
curl https://eg-wallet-backend-production.up.railway.app/health
```

**Expected Response**:
```
OK
```

**Status Code**: Must be `200`

- [ ] ✅ Returns "OK"
- [ ] ✅ Status code is 200
- [ ] ✅ Response time < 3 seconds
- [ ] ✅ No 500/502/503 errors

**Status**: ⬜ PASS / ⬜ FAIL  
**Response**: _________________________________

---

## 🎯 FINAL GATE DECISION

### Summary
- [ ] 1️⃣ Production-mode run: **PASS**
- [ ] 2️⃣ Build-time bundling: **PASS**
- [ ] 3️⃣ Zero errors: **PASS**
- [ ] 4️⃣ Button locks + Idempotency: **PASS**
- [ ] 5️⃣ Smoke tests (all screens): **PASS**
- [ ] 6️⃣ Backend health: **PASS**

### Overall Status
- [ ] ✅ **ALL CHECKS PASSED** → PROCEED TO BUILD
- [ ] ❌ **ONE OR MORE FAILED** → DO NOT BUILD (fix and retest)

---

## ✅ BUILD COMMAND (Only if all passed)

```bash
eas build -p android --profile production --non-interactive
```

**Build Started**: _____________ (time)  
**Build ID**: _____________  
**Build Status**: _____________  
**APK/AAB URL**: _____________

---

## 📝 Sign-Off

**Validated By**: _____________  
**Date/Time**: _____________  
**All Checks**: ✅ PASSED / ❌ FAILED  

**Notes/Issues**:
```


```

---

## 🔥 Critical Failure Scenarios

**If ANY of these happen → STOP BUILD IMMEDIATELY**:
1. ❌ Metro bundler shows red errors
2. ❌ `npx expo export` fails
3. ❌ App crashes on launch
4. ❌ Payment button fires twice
5. ❌ QR Payment doesn't navigate
6. ❌ Offline mode crashes app
7. ❌ Backend health check fails
8. ❌ Any unhandled promise rejection

**Fix first, then restart entire gate process.**
