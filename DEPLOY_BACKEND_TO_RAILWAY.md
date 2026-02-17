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
JWT_SECRET=your_secure_random_string_here
NODE_ENV=production
```

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
