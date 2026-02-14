# Railway Deployment Fix - Quick Steps

## What Was Fixed

1. **Syntax Error**: Removed duplicate code in index.js (lines 326-353)
2. **Health Check**: Added `/healthz` endpoint (Railway's default)
3. **Port Binding**: Changed to bind to `0.0.0.0` instead of localhost
4. **Start Command**: Updated to use `node index.js` directly
5. **Logging**: Added startup diagnostics

## Deploy to Railway NOW

### Option 1: Via Railway Dashboard (Recommended)

1. **Go to Railway Dashboard**
   - URL: https://railway.app/dashboard
   - Open your project: `eg-wallet-backend-production`

2. **Update Code**
   ```powershell
   cd C:\Users\fmba1\Downloads\EGWalletSimple\mock-backend
   git add .
   git commit -m "Fix backend routes and Railway deployment"
   git push
   ```

3. **Set Environment Variable**
   - In Railway Dashboard → Variables tab
   - Add: `JWT_SECRET` = `YOUR_SECURE_RANDOM_STRING_HERE`
   - (Must be set or app won't start properly)

4. **Check Root Directory Setting**
   - Settings → Service Settings
   - If deploying from root repo, set Root Directory to: `mock-backend`
   - If you created a separate repo for backend, leave empty

5. **Redeploy**
   - Railway should auto-deploy after git push
   - OR click "Deploy" button manually
   - Watch deployment logs for: "EGWallet backend running on port XXXX"

### Option 2: Via Railway CLI

```powershell
cd mock-backend
railway up
```

## Verify Deployment

After deployment completes (~2-3 minutes):

```powershell
# Test health check
curl https://eg-wallet-backend-production.up.railway.app/healthz

# Test rates endpoint (the one that was crashing)
curl https://eg-wallet-backend-production.up.railway.app/rates

# Should return JSON with currencies
```

## Expected Output

If working correctly, you'll see:
- `/healthz` returns: `OK`
- `/rates` returns: JSON with base currency and exchange rates
- No 404 errors

## Troubleshooting

### If still getting 404:
1. Check Railway logs: Dashboard → Deployments → View logs
2. Look for: "EGWallet backend running on port XXXX"
3. Verify JWT_SECRET is set in Variables
4. Ensure correct root directory is configured

### If deployment fails:
1. Check logs for error messages
2. Verify package.json exists in deployed folder
3. Ensure node_modules are being installed
4. Check that PORT environment variable is being read

## After Successful Deployment

The mobile app (versionCode 6) will connect automatically and should NOT crash anymore because:
- ✅ Backend URL is correct: https://eg-wallet-backend-production.up.railway.app
- ✅ /rates endpoint is fixed and working
- ✅ All API routes are properly registered
- ✅ App startup logging will confirm connection

## Files Changed

- `index.js` - Fixed syntax error, added /healthz, improved logging
- `railway.json` - Updated healthcheck path and start command
- `RAILWAY_DEPLOY.md` - Comprehensive deployment guide
- `DEPLOY_NOW.md` - This quick start guide

---

**Next Step:** Push code to GitHub and Railway will auto-deploy! 🚀
