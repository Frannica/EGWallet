# Final Action Items for Launch

**Date:** February 3, 2026  
**Status:** 23 of 25 items complete - Ready for final configuration  
**Target:** Google Play Store submission for Equatorial Guinea  

---

## Item #24: Privacy Policy & Terms Pages

### Current Status
- AboutScreen has links to legal pages
- URLs are currently placeholders
- Impact: Low (can be updated post-launch if needed)

### Current URLs
```
Privacy Policy: https://egwallet.com/privacy
Terms of Service: https://egwallet.com/terms
```

### Options

#### Option A: Deploy Legal Pages (Recommended)
1. Create privacy policy and terms documents
2. Host on your domain (egwallet.com)
3. Verify links work before submission
4. Update AboutScreen.tsx if URLs differ

**File to Update:** `src/screens/AboutScreen.tsx` (lines ~40-50)

```typescript
// Find these URLs and update:
const PRIVACY_URL = 'https://egwallet.com/privacy';
const TERMS_URL = 'https://egwallet.com/terms';
```

#### Option B: Use Placeholder URLs (v1.0 Launch)
- Submit with placeholder URLs
- Plan to deploy actual pages within 30 days
- Google Play Store may request before approval
- Can be updated in patch release

### Required for Google Play Store
- ✅ Privacy Policy link must be accessible
- ✅ Terms link must be accessible (or explicit policy OK)
- Google may ask you to update these before approving

**Recommendation:** Deploy actual legal pages if possible. If not ready, submit with placeholders and update immediately after approval.

---

## Item #25: Production API URL Configuration

### Current Status
- App is currently configured with placeholder backend URL
- This is THE critical blocking item for full functionality
- Impact: Critical - app cannot function without real backend

### Current Setting
**File:** `src/config/env.ts`

```typescript
// Production endpoint (PLACEHOLDER)
export const API_URL = 'https://api.egwallet.com/api';
```

### What You Need To Do

1. **Obtain your production backend URL**
   - This should be your actual backend server
   - Example formats:
     - `https://api.mycompany.com/api`
     - `https://backend.egwallet.example.com/api`
     - `https://api.egwallet.custom.server/api`

2. **Update the URL in src/config/env.ts**
   ```typescript
   // Replace this:
   export const API_URL = 'https://api.egwallet.com/api';
   
   // With your actual backend:
   export const API_URL = 'https://your-actual-api.com/api';
   ```

3. **Verify the backend is ready**
   - Backend must be deployed and accessible
   - Must support HTTPS (not HTTP)
   - Must have all API endpoints ready:
     - `/auth/login` - User login
     - `/auth/register` - User registration
     - `/auth/me` - Get user profile
     - `/wallet/list` - List user wallets
     - `/wallet/send` - Send transaction
     - `/wallet/transactions` - Get transaction history
     - `/rates` - Get exchange rates

4. **Test the connection**
   - Start the app with new URL
   - Try to log in
   - Check that rates load
   - Verify transactions can be sent

### Backend API Requirements

The app expects these endpoints:

#### POST /auth/login
```typescript
Request: { email: string, password: string }
Response: { token: string }
```

#### POST /auth/register
```typescript
Request: { email: string, password: string, region?: string }
Response: { token: string }
```

#### GET /auth/me
```typescript
Headers: { Authorization: 'Bearer <token>' }
Response: { id: string, email: string }
```

#### GET /wallet/list
```typescript
Headers: { Authorization: 'Bearer <token>' }
Response: { wallets: Array<{id, balances: Array<{currency, amount}>}> }
```

#### POST /wallet/send
```typescript
Headers: { Authorization: 'Bearer <token>' }
Request: { 
  fromWalletId: string, 
  toWalletId: string, 
  amount: number,
  currency: string 
}
Response: { success: boolean, transactionId: string }
```

#### GET /wallet/transactions
```typescript
Headers: { Authorization: 'Bearer <token>' }
Query: { walletId: string }
Response: { transactions: Array<{id, from, to, amount, currency, date}> }
```

#### GET /rates
```typescript
Response: { rates: { USD: 1, XAF: 600, NGN: 1200, ... } }
```

### Testing the Backend

1. **Test with mock backend locally** (good for development)
   ```bash
   cd mock-backend
   npm install
   npm start
   ```
   Then set API_URL to `http://localhost:3000/api` in dev

2. **Test with production backend** (before submission)
   - Use Postman or similar tool to test endpoints
   - Verify all 32 currencies have rates
   - Verify authentication flow works
   - Verify wallet operations work

### Critical Checklist for Backend

- [ ] Backend is deployed and accessible
- [ ] All endpoints return correct response format
- [ ] All 32 currencies have exchange rates
- [ ] HTTPS is enforced (no HTTP)
- [ ] CORS is configured for mobile app domain
- [ ] Error responses are clear (user-friendly messages)
- [ ] Timeout is handled gracefully (within 30 seconds)
- [ ] Rate limits are appropriate for mobile app
- [ ] Token expiration is handled
- [ ] User data is properly encrypted
- [ ] Regulatory compliance (KYC) requirements met for Equatorial Guinea

---

## Summary: Ready to Launch!

### ✅ What's Complete (23 Items)
- Regional auto-detection ✓
- Spanish language support ✓
- Error handling (offline, crashes, network) ✓
- KYC/limits disclosure ✓
- Secure authentication ✓
- 32 currencies ✓
- Feature gating ✓
- And 16 more items...

### ⏳ What's Needed (2 Items)
1. **Privacy Policy & Terms** - Can use placeholders for now
2. **Production API URL** - Critical, must be configured

### Next Steps

1. **This Week**
   - [ ] Finalize backend server and obtain production URL
   - [ ] Update src/config/env.ts with real API URL
   - [ ] Test app with real backend
   - [ ] Prepare legal pages or confirm placeholder URLs OK

2. **Before Submission**
   - [ ] Final testing with real backend
   - [ ] Verify all error messages display correctly
   - [ ] Test on low-end Android device
   - [ ] Confirm no console logs in release build

3. **Submission**
   - [ ] Upload AAB to Google Play Console
   - [ ] Fill in store listing (Spanish for GQ)
   - [ ] Submit for review
   - [ ] Monitor for approval or feedback

---

## Support

For any questions about configuration:
- Check `REGIONAL_READINESS_CHECKLIST.md` for implementation details
- Check `IMPLEMENTATION_SUMMARY.md` for code changes
- Review the mock backend in `/mock-backend` for API format examples

**Status:** 🟢 Ready to configure and launch!

