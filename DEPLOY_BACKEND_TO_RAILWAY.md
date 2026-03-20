# Deploy Backend to Railway - Final Steps

## ✅ What's Been Done

1. Renamed `mock-backend/` → `backend/` (no more "mock" confusion!)
2. Updated package.json: `egwallet-backend` v1.0.0
3. Fixed all syntax errors and added Railway health checks
4. Tested locally - everything works ✓

## 🚀 Deploy to Railway NOW

### Step 1: Push to GitHub

```powershell
cd C:\Users\fmba1\Downloads\EGWalletSimple
git add .
git commit -m "Rename mock-backend to backend - production ready"
git push
```

### Step 2: Update Railway Settings

1. Go to **Railway Dashboard**: https://railway.app/dashboard
2. Open project: **eg-wallet-backend-production**
3. Click **Settings** tab
4. Find **Root Directory** setting
5. Change from `mock-backend` to `backend`
6. Click **Save**

### Step 3: Set Environment Variables (if not already set)

In **Variables** tab, ensure you have:
```
NODE_ENV=production
JWT_SECRET=<run: openssl rand -base64 32>
JWT_REFRESH_SECRET=<run: openssl rand -base64 32>

# Firebase Admin SDK — paste the ENTIRE contents of service-account-key.json as one value
FIREBASE_SERVICE_ACCOUNT_JSON={"type":"service_account","project_id":"xenon-monitor-466901-f0",...}

# Stripe (optional — leave blank for demo mode)
STRIPE_SECRET_KEY=sk_live_...

# CORS — add your Railway domain after deploy
ALLOWED_ORIGINS=https://your-app.up.railway.app,https://your-frontend.com
```

> **How to set FIREBASE_SERVICE_ACCOUNT_JSON on Railway:**
> 1. Open `service-account-key.json` in a text editor
> 2. Copy the entire file contents (it's a single JSON object)
> 3. In Railway → Variables → New Variable
> 4. Name: `FIREBASE_SERVICE_ACCOUNT_JSON`
> 5. Value: paste the JSON (Railway stores it securely as a single-line string)
> 6. Save — Railway will redeploy automatically

### Step 4: Redeploy

- Railway should auto-deploy after git push
- OR click **Deployments** → **Deploy** to trigger manually
- Watch logs for: "EGWallet backend running on port XXXX"

### Step 5: Verify Deployment

After ~2 minutes, test:

```powershell
# Health check
curl https://eg-wallet-backend-production.up.railway.app/healthz

# Rates endpoint (the critical one)
curl https://eg-wallet-backend-production.up.railway.app/rates
```

**Expected:** Both should return successful responses (not 404)

## ✅ After Successful Deployment

Your mobile app (versionCode 6 AAB) will:
- ✅ Connect to Railway backend automatically
- ✅ NOT crash on startup
- ✅ Show debug log: "🚀 App Startup - Production API URL: https://eg-wallet-backend-production.up.railway.app"

## 📱 Final Testing

1. Upload AAB to Google Play Console (Closed Testing)
2. Install on test device
3. Check logs for startup message
4. Test login/send money features

---

**That's it! Your production backend is ready.** 🎉
