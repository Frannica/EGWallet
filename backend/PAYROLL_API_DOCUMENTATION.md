# Payroll System - Complete API Documentation

## 🎯 System Overview

**No Line. No Suffering. No Humiliation.**

EGWallet's payroll system enables employers to pay workers digitally with instant access to funds.

---

## 🔐 KYC Tier System

### Tier Levels & Limits

| Tier | Name | Requirements | Daily Limit | Total Capacity | Purpose |
|------|------|--------------|-------------|----------------|---------|
| **0** | Trial | Phone number only | $100/day | $500 total | Onboarding trial |
| **1** | Worker | Full name, DOB, ID photo | $5,000/day | $50,000 total | Workers (receive payroll) |
| **2** | Small Business | Tier 1 + Address, selfie | $25,000/day | $250,000 total | Employers (small) |
| **3** | Enterprise | Tier 2 + Business docs | Unlimited | Unlimited | Employers (enterprise) |

**To Become an Employer**: User must be at least **Tier 2**

---

## 📊 Complete API Flow

### Step 1: User Registration (Worker)
```bash
POST /auth/register
```

**Request:**
```json
{
  "email": "worker@example.com",
  "password": "SecurePass123",
  "region": "GQ"
}
```

**Response:**
```json
{
  "success": true,
  "token": "eyJhbGciOiJIUzI1NiIs...",
  "user": {
    "id": "user-uuid",
    "email": "worker@example.com",
    "kycTier": 0,
    "kycStatus": "pending"
  }
}
```

**Default KYC**: New users start at **Tier 0** (pending approval)

---

### Step 2: Upgrade KYC Tier (Admin Action)

```bash
POST /admin/update-kyc-tier
Authorization: Bearer <admin-token>
```

**Request:**
```json
{
  "userId": "worker-uuid",
  "kycTier": 1,
  "kycStatus": "approved"
}
```

**Response:**
```json
{
  "success": true,
  "user": {
    "id": "worker-uuid",
    "email": "worker@example.com",
    "kycTier": 1,
    "kycStatus": "approved",
    "kycLimits": {
      "dailyLimit": 5000,
      "totalLimit": 50000
    }
  }
}
```

**For Employer**: Set `kycTier: 2` or `3`

---

### Step 3: Register as Employer

```bash
POST /employer/register
Authorization: Bearer <token>
```

**Requirements**:
- User must be **Tier 2+**
- User must be KYC approved

**Request:**
```json
{
  "companyName": "Company ABC",
  "taxId": "GQ-TAX-123456",
  "businessLicense": "LICENSE-789",
  "employeeCount": 250,
  "fundingCurrency": "XAF"
}
```

**Response:**
```json
{
  "success": true,
  "employer": {
    "id": "EMP-uuid",
    "companyName": "Company ABC",
    "verificationStatus": "pending",
    "fundingWalletId": "WALLET-EMP-uuid"
  }
}
```

**Employer Status**: Starts as `"pending"` → Admin must verify

---

### Step 4: Verify Employer (Admin Action)

```bash
POST /admin/verify-employer
Authorization: Bearer <admin-token>
```

**Request:**
```json
{
  "employerId": "EMP-uuid",
  "verificationStatus": "verified",
  "notes": "Business license verified, bank account confirmed"
}
```

**Response:**
```json
{
  "success": true,
  "employer": {
    "id": "EMP-uuid",
    "companyName": "Company ABC",
    "verificationStatus": "verified",
    "verifiedAt": 1708261200000
  }
}
```

**Only verified employers can send payroll**

---

### Step 5: Fund Employer Wallet

**Manual Process** (for demo):
1. Admin adds balance to employer's funding wallet
2. In production: Bank transfer, mobile money, etc.

**Example** (direct DB edit for demo):
```json
{
  "id": "WALLET-EMP-uuid",
  "userId": "employer-user-id",
  "employerId": "EMP-uuid",
  "type": "employer_funding",
  "balances": [
    { "currency": "XAF", "amount": 100000000 }  // 100M XAF
  ]
}
```

---

### Step 6: Upload Payroll CSV

```bash
POST /employer/upload-payroll
Authorization: Bearer <employer-token>
Content-Type: multipart/form-data
```

**CSV Format** (3 required columns):

| worker_id | amount | currency | name (optional) | memo (optional) |
|-----------|--------|----------|-----------------|-----------------|
| user-uuid-1 | 350000 | XAF | John Doe | February payroll |
| user-uuid-2 | 500000 | XAF | Maria Garcia | February payroll |
| user-uuid-3 | 400000 | XAF | Carlos Lopez | February payroll |

**Alternative**: Use `email` instead of `worker_id`

**CSV Example:**
```csv
email,amount,currency,name,memo
worker1@example.com,350000,XAF,John Doe,February 2026 Payroll
worker2@example.com,500000,XAF,Maria Garcia,February 2026 Payroll
worker3@example.com,400000,XAF,Carlos Lopez,February 2026 Payroll
```

**cURL Example:**
```bash
curl -X POST http://localhost:4000/employer/upload-payroll \
  -H "Authorization: Bearer <employer-token>" \
  -F "payrollFile=@payroll-feb-2026.csv"
```

**Response:**
```json
{
  "success": true,
  "totalRows": 3,
  "validItems": 3,
  "errors": 0,
  "errorDetails": [],
  "preview": [
    {
      "rowNum": 2,
      "workerId": "user-uuid-1",
      "workerEmail": "worker1@example.com",
      "workerName": "John Doe",
      "walletId": "WALLET-uuid-1",
      "amount": 350000,
      "currency": "XAF",
      "memo": "February 2026 Payroll"
    },
    {
      "rowNum": 3,
      "workerId": "user-uuid-2",
      "workerEmail": "worker2@example.com",
      "workerName": "Maria Garcia",
      "walletId": "WALLET-uuid-2",
      "amount": 500000,
      "currency": "XAF",
      "memo": "February 2026 Payroll"
    }
  ],
  "totalAmount": 2083.33  // USD equivalent
}
```

**Validation Errors Example:**
```json
{
  "success": true,
  "totalRows": 5,
  "validItems": 3,
  "errors": 2,
  "errorDetails": [
    { "row": 3, "error": "Worker not found: invalid-email@example.com" },
    { "row": 5, "error": "Invalid amount: -100" }
  ]
}
```

---

### Step 7: Send Bulk Payroll

```bash
POST /employer/bulk-payment
Authorization: Bearer <employer-token>
```

**Request:**
```json
{
  "payrollItems": [
    {
      "workerId": "user-uuid-1",
      "workerEmail": "worker1@example.com",
      "walletId": "WALLET-uuid-1",
      "amount": 350000,
      "currency": "XAF",
      "memo": "February 2026 Payroll"
    },
    {
      "workerId": "user-uuid-2",
      "workerEmail": "worker2@example.com",
      "walletId": "WALLET-uuid-2",
      "amount": 500000,
      "currency": "XAF",
      "memo": "February 2026 Payroll"
    }
  ],
  "payPeriod": "2026-02",
  "notes": "February 2026 monthly payroll"
}
```

**Response:**
```json
{
  "success": true,
  "batchId": "BATCH-1708261200000-abc123",
  "totalItems": 2,
  "successCount": 2,
  "failureCount": 0,
  "status": "completed",
  "results": [
    {
      "workerId": "user-uuid-1",
      "workerEmail": "worker1@example.com",
      "status": "success",
      "transactionId": "TXN-uuid-1",
      "amount": 350000,
      "currency": "XAF"
    },
    {
      "workerId": "user-uuid-2",
      "workerEmail": "worker2@example.com",
      "status": "success",
      "transactionId": "TXN-uuid-2",
      "amount": 500000,
      "currency": "XAF"
    }
  ]
}
```

**Partial Success Example** (some payments failed):
```json
{
  "success": false,
  "batchId": "BATCH-1708261200000-xyz789",
  "totalItems": 3,
  "successCount": 2,
  "failureCount": 1,
  "status": "partial",
  "results": [
    {
      "workerId": "user-uuid-1",
      "workerEmail": "worker1@example.com",
      "status": "success",
      "transactionId": "TXN-uuid-1",
      "amount": 350000,
      "currency": "XAF"
    },
    {
      "workerId": "user-uuid-3",
      "workerEmail": "worker3@example.com",
      "status": "failed",
      "error": "Wallet not found"
    }
  ]
}
```

**Error: Insufficient Funds**
```json
{
  "error": "Insufficient funds",
  "message": "Need 1250000 XAF, but only have 1000000 XAF",
  "currency": "XAF",
  "needed": 1250000,
  "available": 1000000
}
```

---

### Step 8: Worker Receives Notification

**Worker's Perspective** (when they check wallet):

```bash
GET /payroll/received
Authorization: Bearer <worker-token>
```

**Response:**
```json
{
  "payrollTransactions": [
    {
      "id": "TXN-uuid-1",
      "amount": 350000,
      "currency": "XAF",
      "employerName": "Company ABC",
      "payPeriod": "2026-02",
      "receivedAt": 1708261200000,
      "memo": "February 2026 Payroll"
    }
  ]
}
```

**Mobile App Notification** (future feature):
> 💰 **You received 350,000 XAF from Company ABC**

**Worker's Options:**
1. ✅ Keep in wallet (instant)
2. 💳 Withdraw to bank (future: mobile money integration)
3. 👨‍👩‍👧‍👦 Send to family (existing: `/transactions`)
4. 💱 Convert currency (existing: multi-currency support)

---

## 📋 Employer Endpoints Summary

### Core Payroll Flow
```
1. POST /employer/register           → Register as employer (Tier 2+ required)
2. POST /admin/verify-employer       → Admin verifies employer
3. POST /employer/upload-payroll     → Upload CSV, get preview
4. POST /employer/bulk-payment       → Send all payments in one batch
5. GET  /employer/payroll-history    → View all past batches
6. GET  /employer/payroll-batch/:id  → View specific batch details
```

### Supporting Endpoints
```
GET  /employer/profile               → Get employer info & funding wallet
POST /admin/update-kyc-tier          → Upgrade user's KYC tier (admin)
GET  /payroll/received               → Worker views received payroll
```

---

## 🧪 Testing Guide

### Create Test Environment

**1. Register 3 Workers:**
```bash
# Worker 1
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "worker1@egwallet.test",
    "password": "Worker1Pass",
    "region": "GQ"
  }'

# Worker 2
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "worker2@egwallet.test",
    "password": "Worker2Pass",
    "region": "GQ"
  }'

# Worker 3
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "worker3@egwallet.test",
    "password": "Worker3Pass",
    "region": "GQ"
  }'
```

**2. Register Employer:**
```bash
curl -X POST http://localhost:4000/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "employer@companyabc.gq",
    "password": "EmployerPass123",
    "region": "GQ"
  }'
```

**3. Upgrade KYC (Admin - use any token for demo):**
```bash
# Upgrade workers to Tier 1
curl -X POST http://localhost:4000/admin/update-kyc-tier \
  -H "Authorization: Bearer <any-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "<worker1-id>",
    "kycTier": 1,
    "kycStatus": "approved"
  }'

# Upgrade employer to Tier 2
curl -X POST http://localhost:4000/admin/update-kyc-tier \
  -H "Authorization: Bearer <any-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "<employer-id>",
    "kycTier": 2,
    "kycStatus": "approved"
  }'
```

**4. Create Employer Account:**
```bash
curl -X POST http://localhost:4000/employer/register \
  -H "Authorization: Bearer <employer-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "companyName": "Company ABC",
    "taxId": "GQ-TAX-ABC-2026",
    "businessLicense": "GQ-BIZ-12345",
    "employeeCount": 3,
    "fundingCurrency": "XAF"
  }'
```

**5. Verify Employer (Admin):**
```bash
curl -X POST http://localhost:4000/admin/verify-employer \
  -H "Authorization: Bearer <admin-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "employerId": "<employer-id>",
    "verificationStatus": "verified",
    "notes": "Verified business license and tax ID"
  }'
```

**6. Fund Employer Wallet (Manual - edit db.json):**
```json
{
  "id": "WALLET-EMP-...",
  "balances": [
    { "currency": "XAF", "amount": 50000000 }  // 50M XAF
  ]
}
```

**7. Create Payroll CSV (payroll.csv):**
```csv
email,amount,currency,name,memo
worker1@egwallet.test,350000,XAF,John Doe,February 2026 Payroll
worker2@egwallet.test,500000,XAF,Maria Garcia,February 2026 Payroll
worker3@egwallet.test,400000,XAF,Carlos Lopez,February 2026 Payroll
```

**8. Upload CSV:**
```bash
curl -X POST http://localhost:4000/employer/upload-payroll \
  -H "Authorization: Bearer <employer-token>" \
  -F "payrollFile=@payroll.csv"
```

**9. Send Payroll:**
```bash
# Use the "payrollItems" array from the upload response
curl -X POST http://localhost:4000/employer/bulk-payment \
  -H "Authorization: Bearer <employer-token>" \
  -H "Content-Type: application/json" \
  -d '{
    "payrollItems": [...],  // From upload response
    "payPeriod": "2026-02",
    "notes": "February monthly payroll"
  }'
```

**10. Check Worker Received:**
```bash
curl -X GET http://localhost:4000/payroll/received \
  -H "Authorization: Bearer <worker1-token>"
```

---

## 🔍 Transaction Details

### Payroll Transaction Structure

```json
{
  "id": "TXN-uuid",
  "type": "payroll",
  "fromWalletId": "WALLET-EMP-uuid",
  "toWalletId": "WALLET-worker-uuid",
  "amount": 350000,
  "currency": "XAF",
  "status": "completed",
  "createdAt": 1708261200000,
  "memo": "February 2026 Payroll",
  
  "payrollMetadata": {
    "employerId": "EMP-uuid",
    "employerName": "Company ABC",
    "payPeriod": "2026-02",
    "payrollBatchId": "BATCH-1708261200000-abc123",
    "workerId": "user-uuid",
    "workerEmail": "worker@example.com",
    "isRecurring": false
  },
  
  "complianceFlags": {
    "taxable": true,
    "reportable": true,
    "category": "wages"
  }
}
```

**Why Tagging Matters:**
- 🏛️ **Tax Authorities**: Distinguish payroll from personal transfers
- 🛡️ **AML Compliance**: Track large business payments
- 📊 **Audit Trail**: Employer can prove payroll sent
- 🔍 **Dispute Resolution**: Worker can prove employment

---

## 📊 Compliance Reporting

### Monthly Payroll Report

```bash
GET /employer/payroll-history
Authorization: Bearer <employer-token>
```

**Response:**
```json
{
  "batches": [
    {
      "id": "BATCH-2026-02-15-001",
      "employerId": "EMP-uuid",
      "employerName": "Company ABC",
      "payPeriod": "2026-02",
      "status": "completed",
      "totalItems": 250,
      "successCount": 250,
      "failureCount": 0,
      "createdAt": 1708261200000,
      "completedAt": 1708261300000,
      "transactions": ["TXN-1", "TXN-2", ...]
    },
    {
      "id": "BATCH-2026-01-15-001",
      "payPeriod": "2026-01",
      "totalItems": 250,
      "successCount": 248,
      "failureCount": 2,
      ...
    }
  ]
}
```

**Tax Reporting** (for authorities):
- Total payroll sent: Sum all batch amounts
- Per-employee breakdown: Query by worker ID
- Taxable income: All payroll transactions

---

## 🚨 Error Handling

### Common Errors

**1. Employer Not Verified**
```json
{
  "error": "Employer not verified",
  "message": "Your employer account must be verified before sending payroll"
}
```
**Solution**: Wait for admin to verify employer account

**2. Insufficient KYC Tier**
```json
{
  "error": "Insufficient KYC tier",
  "message": "You must complete Tier 2 KYC verification to register as an employer",
  "currentTier": 1,
  "requiredTier": 2
}
```
**Solution**: Upload business documents, wait for Tier 2 approval

**3. Worker Not Found**
```json
{
  "error": "Invalid CSV format",
  "errorDetails": [
    { "row": 5, "error": "Worker not found: oldemployee@example.com" }
  ]
}
```
**Solution**: Remove invalid rows from CSV, or ask worker to register

**4. Insufficient Funds**
```json
{
  "error": "Insufficient funds",
  "message": "Need 5000000 XAF, but only have 3000000 XAF",
  "currency": "XAF",
  "needed": 5000000,
  "available": 3000000
}
```
**Solution**: Fund employer wallet before sending payroll

**5. Invalid CSV Format**
```json
{
  "error": "Invalid CSV format",
  "message": "CSV must contain \"amount\" column"
}
```
**Solution**: Add required columns: `worker_id`/`email`, `amount`, `currency`

---

## 🎯 Success Metrics

### Track These KPIs

**Employer Dashboard** (future UI):
- Total payroll sent (all-time)
- Total batches processed
- Success rate (% successful payments)
- Average batch size
- Top payment periods

**Worker Experience**:
- Payroll received count
- Total earnings (by period)
- Employers worked with
- Withdrawal history

---

## 🚀 Next Features (Roadmap)

### Phase 2: Worker Experience
- [ ] Push notifications ("You received 350,000 XAF from Company ABC")
- [ ] Mobile money withdrawal (MTN, Orange, Airtel)
- [ ] Bank transfer integration
- [ ] Saved family contacts
- [ ] Recurring family payments

### Phase 3: Employer Features
- [ ] Recurring payroll (auto-send on schedule)
- [ ] Employee roster management
- [ ] Payroll analytics dashboard
- [ ] Tax reporting exports
- [ ] Multi-currency payroll

### Phase 4: Advanced
- [ ] Auto-KYC (OCR ID scanning)
- [ ] Payroll advance (worker loans)
- [ ] Savings goals
- [ ] Insurance products

---

## 📞 Support

**Technical Issues**: dev@egwallet.com  
**Employer Verification**: compliance@egwallet.com  
**General Support**: support@egwallet.com

---

**Status**: ✅ **Payroll System Complete**  
**Last Updated**: February 18, 2026  
**Version**: 1.0.0  
**Mission**: No line. No suffering. No humiliation. 🛡️
