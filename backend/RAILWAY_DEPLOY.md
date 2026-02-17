# Railway Deployment Instructions

## Quick Deploy

1. **Push code to GitHub**
   ```bash
   cd backend
   git add .
   git commit -m "Update backend for Railway"
   git push
   ```

2. **Railway Dashboard Setup**
   - Go to: https://railway.app/dashboard
   - Select your project: `eg-wallet-backend-production`
   - Go to **Settings** tab

3. **Configure Environment Variables**
   Click "Variables" and add:
   ```
   JWT_SECRET=your_secure_random_string_here_change_me_in_production
   NODE_ENV=production
   ```

4. **Verify Root Directory**
   - In Settings → "Service Settings"
   - Set **Root Directory**: `backend` (if deploying from root repo)
   - OR deploy the backend folder as a separate repo

5. **Redeploy**
   - Go to **Deployments** tab
   - Click "Deploy" to trigger new deployment
   - Watch logs for startup messages

## Verify Deployment

Test endpoints after deployment:

```bash
# Health check
curl https://eg-wallet-backend-production.up.railway.app/healthz

# Rates endpoint
curl https://eg-wallet-backend-production.up.railway.app/rates

# Register test user
curl -X POST https://eg-wallet-backend-production.up.railway.app/auth/register \
  -H "Content-Type: application/json" \
  -d '{"email":"test@example.com","password":"Test123!","region":"GQ"}'
```

## Troubleshooting

### If endpoints return 404:
1. Check Railway logs for errors
2. Verify `node index.js` is running (not `npm start`)
3. Ensure JWT_SECRET environment variable is set
4. Check that PORT is being read from environment

### If health check works but API routes don't:
1. The app might be binding to wrong host
2. Check that `app.listen(PORT, '0.0.0.0', ...)` is used
3. Verify Express middleware is loaded before routes

### Common Issues:
- **Missing JWT_SECRET**: App won't start properly
- **Wrong root directory**: Railway can't find package.json
- **Port binding**: Must bind to `0.0.0.0` not `localhost`
- **CORS**: Already configured, should work for all origins

## Production Checklist

- [ ] JWT_SECRET set to secure random value (not 'dev_secret_change_me')
- [ ] All endpoints tested and working
- [ ] Logs show successful startup
- [ ] Frontend app connects successfully
- [ ] Database persistence working (db.json)

## Support

If issues persist, check Railway logs:
```bash
railway logs
```

Or contact Railway support with deployment ID.
