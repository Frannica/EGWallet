# EGWallet - Core Vision & Mission

## 🎯 The Problem We Solve

**Workers in Equatorial Guinea face humiliation at payday:**
- Long lines at banks
- Cash-only payments (unsafe)
- No control over money
- Difficulty sending to family
- High remittance fees
- Currency conversion problems

## 💡 Our Solution

**No line. No suffering. No humiliation.**

### For Employers
Easy payroll disbursement without handling cash:
1. Upload CSV payroll list
2. Select currency (XAF, USD, etc.)
3. Send bulk payments with one click
4. Track all disbursements
5. Compliance reporting

### For Workers
Dignity and control over their earnings:
1. **Receive**: "You received 350,000 XAF from Company ABC"
2. **Choose instantly**:
   - 💳 Withdraw to bank
   - 🏦 Keep in wallet
   - 👨‍👩‍👧‍👦 Send to family
   - 💱 Convert currency
3. **No waiting**, no lines, no humiliation

---

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   EMPLOYER DASHBOARD                     │
│                                                          │
│  📊 Upload CSV → Select Currency → Bulk Send → Track   │
│                                                          │
│  Features:                                              │
│  • Employer KYC verification                            │
│  • Bulk payment processing                              │
│  • Payroll audit trail                                  │
│  • Employee roster management                           │
│  • Compliance reporting                                 │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                  EGWALLET BACKEND                        │
│                                                          │
│  🛡️ Security & Compliance Layer:                        │
│  • KYC tier verification (Tier 1/2/3)                   │
│  • Transaction limits ($5K daily, $250K capacity)       │
│  • Payroll transaction tagging                          │
│  • Fraud detection (velocity, pattern)                  │
│  • Employer verification                                │
│  • Audit logging (GDPR compliant)                       │
│                                                          │
│  💰 Payment Processing:                                  │
│  • Bulk payroll disbursement                            │
│  • Multi-currency support (32 currencies)               │
│  • Real-time currency conversion                        │
│  • Bank withdrawal integration                          │
│  • Fee calculation (1% transparent)                     │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│                   WORKER MOBILE APP                      │
│                                                          │
│  📱 Receive Notification:                               │
│  "You received 350,000 XAF from Company ABC"           │
│                                                          │
│  ⚡ Instant Choices:                                     │
│  • Withdraw to bank (same day)                          │
│  • Keep in wallet (secure)                              │
│  • Send to family (instant)                             │
│  • Convert currency (real-time rates)                   │
│                                                          │
│  🔒 Security:                                            │
│  • Biometric lock                                       │
│  • PIN protection                                       │
│  • Transaction history                                  │
│  • 24/7 AI support                                      │
└─────────────────────────────────────────────────────────┘
```

---

## ✅ What We Have (World-Class Foundation)

### 1. **Security & Fraud Prevention** ✅
- [x] Rate limiting (DoS protection)
- [x] Fraud detection (15+ keywords, velocity tracking)
- [x] AI-powered support with auto-escalation
- [x] IP tracking & audit logging
- [x] Input validation against injection attacks
- [x] Helmet security headers
- [x] GDPR compliance (export, delete, consent)

### 2. **Multi-Currency System** ✅
- [x] 32 currencies (28 African + 4 international)
- [x] XAF default for Equatorial Guinea
- [x] Real-time currency conversion
- [x] Major/minor unit handling (cents, kobo, etc.)
- [x] Transparent fee display (1%)

### 3. **Transaction Infrastructure** ✅
- [x] Wallet creation & management
- [x] Send/receive transactions
- [x] Transaction history
- [x] Balance tracking (multi-currency)
- [x] Transaction limits ($5K daily, $250K capacity)

### 4. **Worker Mobile App** ✅
- [x] Biometric authentication
- [x] Offline support
- [x] Regional detection (Equatorial Guinea)
- [x] Spanish language support
- [x] Error handling & recovery
- [x] KYC disclosure

### 5. **Enterprise Logging** ✅
- [x] Winston structured logging
- [x] Audit trail (GDPR compliant)
- [x] Freshdesk ticket integration
- [x] Health monitoring endpoints
- [x] Admin dashboard queries

---

## ❌ What We Need (Payroll-Specific)

### 1. **Employer Dashboard** 🔴 CRITICAL
**Status**: Not implemented  
**Priority**: P0 - Blocker

**Features Needed**:
- [ ] Employer registration & verification
  - Company name, tax ID, business license
  - KYC for business owners
  - Bank account verification
  - Annual revenue/employee count
  
- [ ] CSV Payroll Upload
  - Parse CSV (worker_id, name, amount, currency)
  - Validate worker accounts exist
  - Preview before sending
  - Error handling (invalid IDs, insufficient funds)
  
- [ ] Bulk Payment Processing
  - Select wallet/funding source
  - Review total amount + fees
  - One-click bulk send
  - Progress tracking (1/100, 2/100...)
  - Rollback on failure
  
- [ ] Employer Dashboard UI
  - Payment history
  - Employee roster
  - Funding wallet balance
  - Compliance reports (monthly payroll sent)
  - Download receipts

**Technical Implementation**:
```javascript
// Backend endpoints needed:
POST /employer/register
POST /employer/verify-kyc
POST /employer/upload-payroll (CSV)
POST /employer/bulk-payment
GET  /employer/payment-history
GET  /employer/roster
GET  /employer/compliance-report
```

---

### 2. **KYC Tier System** 🟡 HIGH PRIORITY
**Status**: Basic disclosure exists, needs tier levels  
**Priority**: P1 - Required for compliance

**Tier Levels**:

| Tier | Requirements | Limits | Purpose |
|------|-------------|--------|---------|
| **Tier 0** | Phone number only | $100/day, $500 total | Onboarding trial |
| **Tier 1** | Full name, DOB, ID photo | $5,000/day, $50K total | Workers (payroll) |
| **Tier 2** | Tier 1 + Address, selfie | $25,000/day, $250K total | Employers (small) |
| **Tier 3** | Tier 2 + Business docs | Unlimited (custom) | Employers (enterprise) |

**Implementation**:
```javascript
// Add to db.json users:
{
  "kycTier": 1,
  "kycStatus": "approved" | "pending" | "rejected",
  "kycDocuments": {
    "idType": "national_id",
    "idNumber": "GQ123456",
    "idPhotoUrl": "s3://...",
    "selfieUrl": "s3://...",
    "addressProof": "s3://...",
    "businessLicense": "s3://..." // Tier 3
  },
  "kycLimits": {
    "dailyLimit": 5000,
    "totalLimit": 50000
  }
}
```

---

### 3. **Payroll Transaction Tagging** 🟡 HIGH PRIORITY
**Status**: Not implemented  
**Priority**: P1 - Required for compliance

**Why Important**:
- Tax authorities need to distinguish payroll from other transfers
- Anti-money laundering compliance
- Audit trails
- Dispute resolution

**Implementation**:
```javascript
// Add to transactions:
{
  "id": "TXN-xxx",
  "type": "payroll",  // NEW: payroll | personal | business
  "payrollMetadata": {
    "employerId": "EMP-123",
    "employerName": "Company ABC",
    "payPeriod": "2026-02",
    "payrollBatchId": "BATCH-2026-02-15-001",
    "employeeId": "EMP-456",
    "isRecurring": true
  },
  "complianceFlags": {
    "taxable": true,
    "reportable": true,
    "category": "wages"
  }
}
```

---

### 4. **Employer Verification System** 🟡 HIGH PRIORITY
**Status**: Not implemented  
**Priority**: P1 - Required for trust

**Verification Steps**:
1. **Business Registration**
   - Company name, tax ID, address
   - Business license upload
   - Ownership structure
   
2. **Identity Verification**
   - Business owner KYC (Tier 3)
   - Board members (if applicable)
   - Authorized signers
   
3. **Financial Verification**
   - Bank account verification (micro-deposits)
   - Funding source validation
   - Credit check (optional)
   
4. **Operational Verification**
   - Employee count validation
   - Historical payroll (if switching)
   - References

**Backend Schema**:
```javascript
{
  "employers": [
    {
      "id": "EMP-123",
      "companyName": "Company ABC",
      "taxId": "GQ-TAX-123456",
      "businessLicense": "s3://licenses/emp-123.pdf",
      "verificationStatus": "verified" | "pending" | "rejected",
      "verifiedAt": 1708261200000,
      "verifiedBy": "admin-user-id",
      "employeeCount": 250,
      "fundingWalletId": "WALLET-EMP-123",
      "payrollSchedule": "bi-weekly",
      "totalPayrollSent": 125000000, // XAF
      "totalBatches": 24
    }
  ]
}
```

---

### 5. **Bank Withdrawal Integration** 🟠 MEDIUM PRIORITY
**Status**: Not implemented  
**Priority**: P2 - Needed for full experience

**Options**:
1. **Mobile Money Integration** (Faster)
   - MTN Mobile Money (Equatorial Guinea)
   - Orange Money
   - Airtel Money
   
2. **Bank Transfer Integration** (Traditional)
   - Banco Nacional de Guinea Ecuatorial (BANGE)
   - CCEI Bank
   - Societe Generale - GEBC

**Implementation Approach**:
```javascript
// Add withdrawal endpoints:
POST /withdraw/mobile-money
{
  "walletId": "WALLET-123",
  "provider": "MTN",
  "phoneNumber": "+240222123456",
  "amount": 350000,
  "currency": "XAF"
}

POST /withdraw/bank-transfer
{
  "walletId": "WALLET-123",
  "bankCode": "BANGE",
  "accountNumber": "1234567890",
  "accountName": "John Doe",
  "amount": 350000,
  "currency": "XAF"
}

// Status tracking:
GET /withdraw/:withdrawalId/status
// Returns: pending | processing | completed | failed
```

---

### 6. **Push Notifications** 🟠 MEDIUM PRIORITY
**Status**: Not implemented  
**Priority**: P2 - Core experience

**Key Notifications**:
1. **Payroll Received**
   ```
   "You received 350,000 XAF from Company ABC"
   ```

2. **Transaction Completed**
   ```
   "You sent 50,000 XAF to Maria Garcia"
   ```

3. **Withdrawal Completed**
   ```
   "Your 100,000 XAF withdrawal to MTN Money is complete"
   ```

4. **Security Alerts**
   ```
   "New login detected from Malabo, Equatorial Guinea"
   ```

**Implementation** (Expo):
```bash
npm install expo-notifications
```

```javascript
// Backend: Send notification when payroll arrives
await sendPushNotification({
  userId: 'user-123',
  title: 'Payroll Received',
  body: 'You received 350,000 XAF from Company ABC',
  data: { 
    type: 'payroll',
    amount: 350000,
    currency: 'XAF',
    employerId: 'EMP-123'
  }
});
```

---

### 7. **"Send to Family" Feature** 🟢 NICE TO HAVE
**Status**: Partially implemented (generic send)  
**Priority**: P3 - Enhancement

**What's Different**:
- Pre-saved family contacts
- Recurring payments
- Bulk family send
- No wallet ID needed (phone number lookup)

**Enhancement**:
```javascript
// Add to user profile:
{
  "savedContacts": [
    {
      "id": "CONTACT-1",
      "name": "Maria Garcia (Mother)",
      "walletId": "WALLET-MARIA",
      "phoneNumber": "+240222111222",
      "relationship": "mother",
      "recurringPayment": {
        "enabled": true,
        "amount": 50000,
        "currency": "XAF",
        "frequency": "monthly",
        "day": 15
      }
    }
  ]
}
```

---

## 📋 Implementation Roadmap

### Phase 1: Employer MVP (4-6 weeks)
**Goal**: Enable first employer to pay 10 workers

- [ ] Week 1-2: Employer Dashboard (basic)
  - Registration form
  - Manual verification (admin tool)
  - Funding wallet setup
  
- [ ] Week 3-4: Bulk Payroll
  - CSV upload
  - Payment preview
  - Bulk send (batch processing)
  
- [ ] Week 5-6: Compliance
  - Payroll transaction tagging
  - KYC tier enforcement
  - Audit reporting

**Success Metric**: 1 employer pays 10+ workers successfully

---

### Phase 2: Worker Experience (3-4 weeks)
**Goal**: Workers can use their money

- [ ] Week 7-8: Push Notifications
  - Expo notifications setup
  - "You received..." message
  - Transaction alerts
  
- [ ] Week 9-10: Bank/Mobile Money Integration
  - MTN Mobile Money (priority)
  - Withdrawal UI in app
  - Status tracking

**Success Metric**: 50% of workers withdraw or send money within 24 hours

---

### Phase 3: Scale & Polish (4-6 weeks)
**Goal**: 100 employers, 1000+ workers

- [ ] Week 11-12: Automated Verification
  - Auto-KYC for workers (OCR ID scan)
  - Business verification API integration
  
- [ ] Week 13-14: Advanced Features
  - Recurring payroll
  - Family contacts
  - Savings goals
  
- [ ] Week 15-16: Optimization
  - Performance (1000+ concurrent users)
  - Cost optimization (transaction fees)
  - Regional expansion prep

**Success Metric**: 100 employers, 1000 workers, 95% uptime

---

## 🛡️ Compliance & Regulatory

### Required Licenses (Equatorial Guinea)
1. **Payment Service Provider License**
   - Central Bank of Equatorial Guinea (BEAC)
   - Estimated: 6-12 months, $50K+ fees
   
2. **Data Protection Registration**
   - GDPR compliance (already built ✅)
   - Local data storage requirements
   
3. **Anti-Money Laundering (AML)**
   - KYC tiers (Tier 1-3) ✅ planned
   - Transaction monitoring ✅ built
   - Suspicious activity reporting (SAR)

### Ongoing Compliance
- [ ] Monthly AML reports
- [ ] Annual audit (financial, security)
- [ ] Tax reporting (payroll totals)
- [ ] Customer complaint resolution (24-hour SLA)

---

## 💰 Business Model

### Revenue Streams

1. **Transaction Fees** (Current: 1%)
   - Payroll disbursement: 0.5% (discounted for employers)
   - P2P transfers: 1%
   - Currency conversion: 1%
   - **Projected**: $50K/month at 100 employers

2. **Subscription** (Future)
   - Employer tier: $50/month (unlimited employees)
   - Premium worker: $2/month (higher limits, instant withdrawals)

3. **Value-Added Services** (Future)
   - Savings accounts (interest)
   - Micro-loans (payroll advance)
   - Insurance (payroll protection)

---

## 🎯 Success Metrics

### North Star Metric
**Workers paid digitally without humiliation**

### Key Metrics

| Metric | Target (6 months) |
|--------|-------------------|
| Employers onboarded | 100 |
| Workers registered | 5,000 |
| Monthly payroll volume | $2M USD equivalent |
| Worker activation rate | 80% (use wallet after first payroll) |
| Withdrawal success rate | 95% |
| Support ticket resolution | <4 hours |
| Net Promoter Score (NPS) | >50 |

---

## 🚀 Why This Will Succeed

1. **Clear Pain Point**: Workers suffer at payday
2. **Simple Solution**: Digital payroll, instant access
3. **Network Effects**: More employers → more workers → more adoption
4. **Regulatory Moat**: Licensed PSP = competitive advantage
5. **Social Impact**: Dignity for workers = powerful mission
6. **Unit Economics**: 1% fee on $2M = $20K/month, sustainable

---

**Status**: Foundation built ✅, Payroll features needed ❌  
**Timeline**: 12 weeks to full MVP  
**Next Step**: Build Employer Dashboard (Week 1-2)

**Vision**: No line. No suffering. No humiliation. 🛡️
