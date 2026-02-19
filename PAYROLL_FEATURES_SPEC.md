# 🎯 EGWallet Payroll Features - Complete Specification

**Status**: Planning & Implementation Roadmap  
**Date**: February 19, 2026  
**Principle**: Nothing existing gets changed - additive only

---

## ✅ PAYROLL FEATURES WE ARE ADDING (FULL LIST)

### 1) Payroll Transaction Type

**New transaction type**: `payroll`

- **Display**: Payroll appears as: `"Salary from {EmployerName}"`
- **Currency Support**: Payroll supports **all wallet currencies** (same currencies you already support)
- **Implementation**:
  - Transaction object includes `type: "payroll"`
  - UI conditionally renders "Salary from..." based on type
  - No new currency logic needed - reuses existing multi-currency system

---

### 2) Payroll Metadata (attached to payroll transactions only)

**Required Fields**:
- `employerId` - Unique employer identifier
- `employerName` - Display name for UI
- `batchId` - Groups salaries in one payroll run
- `payrollPeriod` - e.g., "Jan 2026", "2026-01", "Q1 2026"
- `reference` / `memo` - Optional note/description

**Optional Future-Ready Fields**:
- `payslipRef` - Link/ID to downloadable payslip
- `employerCountry` - ISO country code for cross-border tracking

**Transaction Structure**:
```json
{
  "id": "TX-uuid",
  "type": "payroll",
  "amount": 350000,
  "currency": "XAF",
  "payrollMetadata": {
    "employerId": "EMP-123",
    "employerName": "Company ABC",
    "batchId": "BATCH-2026-01-31",
    "payrollPeriod": "Jan 2026",
    "reference": "Monthly salary",
    "payslipRef": null,
    "employerCountry": "GQ"
  }
}
```

---

### 3) Employer Role & Account Type (Backend capability)

**Add user role capability**:
- `individual` (default - regular users)
- `employer` (business accounts that pay salaries)
- `admin` (platform administrators)

**User Schema Addition**:
```json
{
  "id": "user-uuid",
  "email": "employer@company.com",
  "role": "employer",
  "employerProfile": {
    "companyName": "Company ABC",
    "verificationStatus": "verified",
    "verifiedAt": 1739913600000,
    "taxId": "GQ-TAX-123",
    "employeeCount": 50
  }
}
```

**Employer Verification**:
- Field/state exists even if verification process evolves
- States: `pending` / `verified` / `rejected`
- Admin can verify/reject employer accounts

---

### 4) Employer ↔ Worker Linking System (Required for security)

**Requirement**: Workers must be **linked** to an employer before they can:
- Request salary from them
- Appear in employer payroll lists
- Receive payroll payments

**Link Creation Methods**:
1. **Employer invite code / employer ID**
   - Employer generates invite code
   - Worker enters code to link
   
2. **Worker request + employer approval**
   - Worker searches/selects employer
   - Employer approves from pending list

**Link Status States**:
- `pending` - Link requested, awaiting approval
- `approved` - Active link, can transact
- `rejected` - Link denied
- `blocked` - Link terminated (fraud/dispute)

**Link Schema**:
```json
{
  "id": "LINK-uuid",
  "workerId": "user-123",
  "employerId": "EMP-456",
  "status": "approved",
  "createdAt": 1739913600000,
  "approvedAt": 1739913700000,
  "approvedBy": "employer-user-id",
  "workerName": "John Doe",
  "workerEmail": "john@example.com",
  "position": "Cashier"
}
```

---

### 5) Salary Request to Employer (Inside Request tab)

**New request path**: `Request → Employer`

**Worker Flow**:
1. Open Request tab
2. Select "Request from Employer" (only shows if linked to ≥1 employer)
3. Choose employer from linked list
4. Enter:
   - Amount
   - Currency
   - Note/memo
5. Submit request

**Employer Flow**:
1. Receives notification: "John Doe requested 350,000 XAF salary"
2. Can approve → pays immediately
3. Can reject → request cancelled
4. Request becomes a **payroll payment** when fulfilled

**Request → Payroll Conversion**:
- When employer approves, transaction is created with `type: "payroll"`
- Includes full payrollMetadata
- Shows as "Salary from {EmployerName}" in worker's wallet

---

### 6) Payroll Request Objects (Unified Request Engine)

**Requests become first-class objects** with:

```json
{
  "requestId": "REQ-uuid",
  "requesterId": "user-worker-id",
  "targetEmployerId": "EMP-123",
  "targetUserId": null,
  "amount": 350000,
  "currency": "XAF",
  "note": "Weekly advance request",
  "expiry": 1739999999999,
  "status": "pending",
  "type": "payroll",
  "createdAt": 1739913600000,
  "paidAt": null,
  "transactionId": null
}
```

**Request Types**:
- `p2p` - Person-to-person request
- `merchant` - Payment request from merchant (future)
- `payroll` - Salary request to employer

**Request States**:
- `pending` - Awaiting action
- `paid` - Fulfilled (transaction created)
- `cancelled` - Requester cancelled
- `expired` - Past expiry timestamp
- `rejected` - Target rejected

---

### 7) Payroll Batch Payout (Employer sends multiple salaries)

**Employer Capability**: Create a payroll "batch"

**Batch Structure**:
```json
{
  "batchId": "BATCH-2026-01-31",
  "employerId": "EMP-123",
  "payrollPeriod": "Jan 2026",
  "status": "completed",
  "createdAt": 1739913600000,
  "completedAt": 1739913700000,
  "payments": [
    {
      "workerId": "user-1",
      "workerName": "John Doe",
      "amount": 350000,
      "currency": "XAF",
      "status": "completed",
      "transactionId": "TX-1"
    },
    {
      "workerId": "user-2",
      "workerName": "Maria Garcia",
      "amount": 500000,
      "currency": "XAF",
      "status": "completed",
      "transactionId": "TX-2"
    }
  ],
  "totalAmount": 850000,
  "totalWorkers": 2,
  "successCount": 2,
  "failureCount": 0
}
```

**Batch Phases**:
- **Phase 1**: Single payout approval (start) - Employer approves entire batch at once
- **Phase 2**: Bulk payouts - Upload CSV, auto-process

**Batch Grouping**:
- All payments in batch share same `batchId`
- Employer can view batch history
- Workers see their payment as part of batch (in metadata)

---

### 8) Worker Choice After Receiving Salary (Core concept)

**When salary arrives, worker can choose**:

✅ **Keep in wallet** (default - no action needed)
✅ **Convert currency** (existing feature - use currency converter)
✅ **Send internationally** (existing feature - use Send tab)
✅ **Withdraw to traditional bank** (future - mobile money integration)

**Implementation Note**:
- These actions **already exist** or are part of wallet capabilities
- Payroll just **triggers** them
- No new UI needed - worker uses existing tabs/features
- Payroll notification can suggest actions: "You received 350,000 XAF. Convert to USD? Send to family?"

---

### 9) Payroll Visibility Rules (No "Coming Soon")

**Principle**: Payroll UI/labels show **only when real payroll data exists**, or when user is linked to an employer

**Visibility Logic**:
```javascript
// Show "Request from Employer" button
if (user.linkedEmployers.length > 0 || user.role === 'employer') {
  showEmployerRequest = true;
}

// Show "Payroll" filter in transaction history
if (transactions.some(tx => tx.type === 'payroll')) {
  showPayrollFilter = true;
}

// Show "Salary from..." banner
if (recentTransactions.some(tx => tx.type === 'payroll' && isRecent)) {
  showSalaryBanner = true;
}
```

**No placeholders allowed**:
- ❌ No disabled "Payroll (Coming Soon)" buttons
- ❌ No greyed-out employer features
- ❌ No empty states saying "Link to employer to see payroll"
- ✅ Features appear when relevant/actionable

---

### 10) Payroll in Wallet UI (Additive display)

**Top area shows** (conditionally):
- Banner: `"Salary from {EmployerName}"` (only when there is a payroll transaction in last 7 days)
- Amount: `350,000 XAF received`
- Action buttons: `Convert` | `Send` | `View Details`

**Filter/Section**: "Payroll"
- Shows payroll transactions only (`type === 'payroll'`)
- Grouped by payrollPeriod or batchId
- Shows employer name prominently

**Currency Integration**:
- Works across **all currencies** (same selector as existing)
- Payroll filter applies to selected currency or "All"
- No separate currency logic needed

**UI Examples**:
```
┌─────────────────────────────────────┐
│ 💰 Salary from Company ABC          │
│ 350,000 XAF received                │
│ [Convert] [Send] [Details]          │
└─────────────────────────────────────┘

Transactions
[All] [Received] [Sent] [Payroll] ←

Payroll (Jan 2026)
━━━━━━━━━━━━━━━━━━━━━━
💼 Salary from Company ABC
   350,000 XAF
   Jan 31, 2026 • Batch #4521
   
💼 Salary from Company ABC
   350,000 XAF
   Dec 31, 2025 • Batch #4489
```

---

### 11) Receipts & Audit Trail (Fintech-grade)

**Every payroll payment includes**:

```json
{
  "transactionId": "TX-uuid",
  "timestamp": 1739913600000,
  "employerReference": "BATCH-2026-01-31",
  "batchId": "BATCH-2026-01-31",
  "payrollPeriod": "Jan 2026",
  "statusTimeline": [
    { "status": "pending", "timestamp": 1739913600000 },
    { "status": "processing", "timestamp": 1739913601000 },
    { "status": "completed", "timestamp": 1739913602000 }
  ],
  "receiptUrl": "https://egwallet.app/receipts/TX-uuid",
  "payslipUrl": null
}
```

**Employer View** (proof of payment):
- Employer can see receipt for each worker payment
- Receipt includes:
  - Worker name (masked: "John D.")
  - Amount + currency
  - Transaction ID
  - Timestamp
  - Batch reference
  - Status: ✅ Completed
- Export capability: PDF receipt per worker or batch summary

---

### 12) Security Controls (Non-negotiable)

#### A) **Idempotency Keys on Payroll Payouts**
```javascript
POST /payroll/batch
{
  "idempotencyKey": "BATCH-2026-01-31-abc123",
  "payments": [...]
}

// If duplicate request with same key:
// Return cached response, do NOT process again
```

#### B) **No Retries on Payroll Send Operations**
- Payroll payouts are **one-shot operations**
- If failure occurs, create new request with new idempotency key
- Prevents accidental double-salary payments

#### C) **Rate Limiting**
- **Requests**: Workers can make max 5 salary requests/hour to each employer
- **Payouts**: Employers can initiate max 10 batches/day (configurable)
- Prevents spam/abuse

#### D) **Velocity Checks**
- Alert if employer sends 100+ payouts in 1 minute (unusual)
- Alert if employer sends 10 batches within 1 hour (unusual)
- Flag for review, don't block (could be legitimate)

#### E) **High-Amount Thresholds**
- Salary payment >$10,000 USD triggers extra confirmation
- Salary payment >$50,000 USD requires admin review
- Step-up authentication for large payroll batches

#### F) **Anti-Spam Controls for Employer Requests**
- Workers can't send same request amount twice in 24 hours
- Workers can't send >5 requests in 1 hour
- Already implemented ✅

#### G) **Block/Report Employer Option (Worker Side)**
```javascript
// Worker can block employer
POST /employer-link/:linkId/block
{
  "reason": "spam" | "fraud" | "harassment" | "other",
  "note": "Employer keeps requesting money back"
}

// Worker can report employer
POST /employer/:employerId/report
{
  "type": "fraud" | "scam" | "fake_payroll" | "other",
  "details": "Employer sent fake payroll, then requested refund"
}
```

#### H) **Audit Logging** (all events logged)
- Salary requests (created, approved, rejected, expired)
- Approvals (who approved, timestamp, amount)
- Payroll payouts (batch created, payments processed, failures)
- Link changes (linked, unlinked, blocked, reported)
- Security events (rate limit hit, velocity triggered, high-amount flagged)

**Audit Log Schema**:
```json
{
  "id": "AUDIT-uuid",
  "type": "payroll_payout_created",
  "userId": "employer-user-id",
  "targetUserId": "worker-user-id",
  "employerId": "EMP-123",
  "batchId": "BATCH-2026-01-31",
  "amount": 350000,
  "currency": "XAF",
  "metadata": {
    "workerCount": 50,
    "totalAmount": 17500000,
    "idempotencyKey": "..."
  },
  "timestamp": 1739913600000,
  "ipAddress": "41.x.x.x",
  "userAgent": "EGWallet-iOS/2.1.0"
}
```

---

### 13) Fraud & Dispute Escalation (AI Support integration)

**If user reports**:
- Unauthorized payroll ("I didn't work for them")
- Money missing ("Payroll shows 500K but I only got 300K")
- Wrong amount ("Contract says 600K, received 400K")
- Dispute / chargeback / fraud

**System automatically**:
1. **Auto-creates Freshdesk ticket**
   - Title: `[PAYROLL DISPUTE] User reports wrong salary amount`
   - Priority: High
   - Tags: `payroll`, `dispute`, `priority`

2. **Includes context**:
   ```json
   {
     "userId": "user-123",
     "transactionId": "TX-abc",
     "employerId": "EMP-456",
     "employerName": "Company ABC",
     "amount": 400000,
     "currency": "XAF",
     "expectedAmount": 600000,
     "payrollPeriod": "Jan 2026",
     "batchId": "BATCH-2026-01-31",
     "aiChatTranscript": "User: I only received 400K but my contract says 600K...",
     "userStatement": "Wrong amount paid"
   }
   ```

3. **AI Support Actions**:
   - Flag transaction for review
   - Notify compliance team
   - Ask clarifying questions via AI chat
   - Collect evidence (screenshots, contract, etc.)
   - Route to human agent if needed

**Dispute Resolution Flow**:
```
User reports issue
  ↓
AI Chat collects details
  ↓
Freshdesk ticket created (auto)
  ↓
Compliance team investigates
  ↓
Resolution:
  - Employer corrects payment
  - Refund issued
  - Account suspended (fraud)
  - Case closed (user error)
```

---

### 14) International Payroll Compatibility (Future-ready but included)

**Payroll transactions support**:

#### A) **Cross-Border Origin Tagging**
```json
{
  "payrollMetadata": {
    "employerCountry": "GQ",
    "workerCountry": "CM",
    "isCrossBorder": true,
    "taxTreaty": "CEMAC"
  }
}
```

#### B) **Multi-Currency Payouts**
- Employer pays in USD
- Worker receives in XAF (auto-converted)
- Conversion tracked:
```json
{
  "amount": 583.33,
  "currency": "USD",
  "receivedAmount": 350000,
  "receivedCurrency": "XAF",
  "exchangeRate": 600,
  "wasConverted": true
}
```

#### C) **Conversion Tracking**
- If salary is paid in one currency and held/converted in another
- Track original currency + converted currency
- Show both on receipt: "Paid 583.33 USD → Received 350,000 XAF"

---

## ✅ ALSO INCLUDED: EGWallet Pay Foundation (Payroll-Compatible)

**Because payroll needs "request + QR" infrastructure to scale in real life**:

### A) **Static QR (Identity Payment)**
- User has permanent QR code = their wallet identity
- Anyone can scan → sends money to that user
- Employer scans worker's QR → pays salary

```json
{
  "type": "static",
  "userId": "user-123",
  "walletId": "WALLET-abc",
  "qrPayload": "egwallet://pay/user-123"
}
```

### B) **Dynamic QR (Invoice/Payment Request with Amount Locked)**
- Worker generates QR with amount embedded
- Employer scans → amount pre-filled → confirms → pays
- Prevents manual entry errors

```json
{
  "type": "dynamic",
  "requestId": "REQ-uuid",
  "amount": 350000,
  "currency": "XAF",
  "memo": "Jan 2026 Salary",
  "qrPayload": "egwallet://pay/REQ-uuid?amount=350000&currency=XAF",
  "expiry": 1739999999999
}
```

### C) **Signed + Expiring QR Payload (Anti-Fraud)**
- QR contains cryptographically signed payload
- Expires after 15 minutes (configurable)
- Prevents QR screenshot reuse

```javascript
// QR Payload Structure
{
  "v": "1",
  "type": "dynamic",
  "requestId": "REQ-uuid",
  "amount": 350000,
  "currency": "XAF",
  "memo": "Jan 2026 Salary",
  "expiry": 1739913900000,
  "signature": "SHA256-HMAC-signed-payload",
  "nonce": "random-unique-value"
}

// Validation
if (payload.expiry < Date.now()) {
  throw "QR expired";
}
if (!verifySignature(payload, SECRET_KEY)) {
  throw "Invalid QR - possible fraud";
}
```

### D) **Unified Request Engine Supports Payroll Requests**
- Same request infrastructure for:
  - P2P requests ("Request from friend")
  - Merchant requests ("Pay invoice")
  - **Payroll requests** ("Request salary from employer")
- Single API endpoint, different `type` field
- Reuses QR code, notification, and approval logic

**Why This Matters for Payroll**:
- Worker can generate QR for salary request
- Employer scans QR at payroll desk
- Instant approval → payment
- No manual entry, no errors
- Works offline (QR scan) → processes when online

---

## 🎯 Implementation Priority

### **Phase 1: Foundation** (Week 1-2)
- [ ] User role field (`individual` / `employer` / `admin`)
- [ ] Employer profile schema
- [ ] Employer ↔ Worker linking system
- [ ] Link status states (pending/approved/rejected/blocked)

### **Phase 2: Core Payroll** (Week 3-4)
- [ ] Payroll transaction type + metadata
- [ ] Salary request to employer (Request tab)
- [ ] Employer approval flow
- [ ] Payroll batch payout (single approval)
- [ ] Transaction tagging + audit trail

### **Phase 3: UI & Experience** (Week 5-6)
- [ ] Payroll visibility rules (conditional rendering)
- [ ] "Salary from..." banner in wallet
- [ ] Payroll filter in transaction history
- [ ] Receipt generation + proof of payment
- [ ] Worker choice prompts after salary received

### **Phase 4: Security** (Week 7-8)
- [ ] Idempotency keys for payouts
- [ ] Rate limiting (requests + payouts)
- [ ] Velocity checks
- [ ] High-amount thresholds
- [ ] Block/report employer functionality
- [ ] Comprehensive audit logging

### **Phase 5: Dispute & Support** (Week 9-10)
- [ ] Fraud reporting flow
- [ ] AI Support integration (auto-create tickets)
- [ ] Dispute escalation to Freshdesk
- [ ] Context-rich ticket creation

### **Phase 6: Scale & Polish** (Week 11-12)
- [ ] Bulk CSV payroll upload
- [ ] Multi-currency conversion tracking
- [ ] Cross-border tagging
- [ ] QR code payment requests
- [ ] Signed + expiring QR payloads
- [ ] International payroll compatibility

---

## 📊 Database Schema Extensions

### **users** (extended)
```json
{
  "id": "user-uuid",
  "email": "user@example.com",
  "role": "individual",
  "employerProfile": null,
  "linkedEmployers": ["EMP-123", "EMP-456"]
}
```

### **employers** (new table)
```json
{
  "id": "EMP-uuid",
  "userId": "user-uuid",
  "companyName": "Company ABC",
  "verificationStatus": "verified",
  "verifiedAt": 1739913600000,
  "taxId": "GQ-TAX-123",
  "employeeCount": 50,
  "fundingWalletId": "WALLET-uuid",
  "linkedWorkers": ["user-1", "user-2"]
}
```

### **employerWorkerLinks** (new table)
```json
{
  "id": "LINK-uuid",
  "employerId": "EMP-123",
  "workerId": "user-789",
  "status": "approved",
  "createdAt": 1739913600000,
  "approvedAt": 1739913700000,
  "workerName": "John Doe",
  "workerEmail": "john@example.com",
  "position": "Cashier"
}
```

### **payrollRequests** (new table - or extend paymentRequests)
```json
{
  "requestId": "REQ-uuid",
  "requesterId": "user-worker-id",
  "targetEmployerId": "EMP-123",
  "amount": 350000,
  "currency": "XAF",
  "note": "Weekly advance",
  "expiry": 1739999999999,
  "status": "pending",
  "type": "payroll",
  "createdAt": 1739913600000,
  "paidAt": null,
  "transactionId": null
}
```

### **payrollBatches** (new table)
```json
{
  "batchId": "BATCH-2026-01-31",
  "employerId": "EMP-123",
  "payrollPeriod": "Jan 2026",
  "status": "completed",
  "createdAt": 1739913600000,
  "completedAt": 1739913700000,
  "idempotencyKey": "BATCH-2026-01-31-abc123",
  "payments": [...],
  "totalAmount": 850000,
  "successCount": 2,
  "failureCount": 0
}
```

### **transactions** (extended)
```json
{
  "id": "TX-uuid",
  "type": "payroll",
  "amount": 350000,
  "currency": "XAF",
  "payrollMetadata": {
    "employerId": "EMP-123",
    "employerName": "Company ABC",
    "batchId": "BATCH-2026-01-31",
    "payrollPeriod": "Jan 2026",
    "reference": "Monthly salary",
    "payslipRef": null,
    "employerCountry": "GQ"
  },
  "statusTimeline": [...]
}
```

### **auditLog** (new table)
```json
{
  "id": "AUDIT-uuid",
  "type": "payroll_payout_created",
  "userId": "employer-user-id",
  "targetUserId": "worker-user-id",
  "employerId": "EMP-123",
  "batchId": "BATCH-2026-01-31",
  "metadata": {...},
  "timestamp": 1739913600000,
  "ipAddress": "41.x.x.x"
}
```

---

## 🚀 Success Metrics

### **User Metrics**:
- % of workers linked to ≥1 employer
- % of transactions that are payroll type
- Average payroll amount
- Payroll frequency (weekly/biweekly/monthly)

### **Employer Metrics**:
- Number of verified employers
- Average workers per employer
- Batch payment success rate
- Time to process batch (target: <5 seconds)

### **Security Metrics**:
- Rate limit hits per day
- Velocity flags per day
- Fraud reports per month
- Dispute resolution time

### **Business Metrics**:
- Payroll volume (USD equivalent)
- Cross-border payroll %
- Multi-currency conversion rate
- QR code adoption rate

---

## ✅ Principles & Constraints

1. **Nothing existing gets changed** - All additive features
2. **No "Coming Soon"** - Features appear when ready/relevant
3. **Security non-negotiable** - All 8 controls must exist
4. **Fintech-grade audit** - Every payroll action logged
5. **Cross-border ready** - Support international payroll from day 1
6. **Worker choice** - Salary enables all existing features (send/convert/withdraw)
7. **Unified infrastructure** - Reuse existing request/QR/payment systems
8. **Fraud-aware** - AI support integration for disputes

---

**Last Updated**: February 19, 2026  
**Status**: Specification Complete - Ready for Implementation  
**Next Step**: Begin Phase 1 (Foundation)
