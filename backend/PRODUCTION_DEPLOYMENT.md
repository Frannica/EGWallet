# EGWallet Production Deployment Guide

## 🎯 Overview

This guide covers deploying EGWallet backend to production with all enterprise features enabled.

---

## ⚡ Quick Start

### 1. Install Dependencies

```bash
cd backend
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
nano .env
```

**Critical Settings**:

```env
# CHANGE IMMEDIATELY
JWT_SECRET=<run: openssl rand -base64 32>
JWT_REFRESH_SECRET=<run: openssl rand -base64 32>

# Production Mode
NODE_ENV=production
PORT=4000

# Freshdesk (REQUIRED for ticketing)
FRESHDESK_DOMAIN=yourdomain.freshdesk.com
FRESHDESK_API_KEY=your_api_key_here

# CORS (ADD YOUR DOMAIN)
ALLOWED_ORIGINS=https://app.egwallet.com,https://www.egwallet.com

# Rate Limiting (ADJUST FOR SCALE)
RATE_LIMIT_MAX_REQUESTS=100
AI_CHAT_RATE_LIMIT=10
AUTH_RATE_LIMIT=5

# Logging
LOG_LEVEL=warn
```

### 3. Start Server

```bash
npm start
```

---

## 🔐 Security Configuration

### Generate Strong JWT Secrets

```bash
# Access Token Secret
openssl rand -base64 32

# Refresh Token Secret
openssl rand -base64 32
```

**Add to .env**:
```env
JWT_SECRET=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789+/==
JWT_REFRESH_SECRET=98765432ZyXwVuTsRqPoNmLkJiHgFeDcBa+/==
```

### Configure Helmet Security Headers

```env
ENABLE_HELMET=true
ENABLE_STRICT_CSP=true  # Use false if you have external scripts
```

**Strict CSP** blocks inline scripts. If your frontend uses CDN scripts, set to `false`.

### Configure CORS

**Development**:
```env
ALLOWED_ORIGINS=http://localhost:19006,http://localhost:8081
```

**Production**:
```env
ALLOWED_ORIGINS=https://app.egwallet.com,https://www.egwallet.com
```

**Mobile Apps**: Automatically allowed (no origin header).

---

## 🎫 Freshdesk Integration

### 1. Get API Key

1. Login to Freshdesk
2. Go to **Profile Settings** → **View API Key**
3. Copy key

### 2. Configure Custom Fields

**Required Custom Fields**:

| Field Name | Type | Description |
|------------|------|-------------|
| `cf_user_id` | Text | User UUID |
| `cf_escalation_type` | Dropdown | fraud_security, account_access, transaction_issues, etc. |
| `cf_ai_detected` | Checkbox | Auto-escalated by AI |
| `cf_sentiment` | Dropdown | frustrated, angry, concerned, confused |
| `cf_sla` | Text | 1 hour, 12 hours, 24 hours |
| `cf_local_ticket_id` | Text | Local ticket ID (TKT-xxx) |

**Steps**:
1. Go to **Admin** → **Ticket Fields**
2. Click **Add New Field**
3. Create each field above
4. Note field IDs (e.g., `cf_user_id`, `cf_escalation_type`)

### 3. Configure .env

```env
FRESHDESK_DOMAIN=yourcompany.freshdesk.com
FRESHDESK_API_KEY=your_api_key_here
```

### 4. Test Integration

```bash
# Start server
npm start

# Create test ticket
curl -X POST http://localhost:4000/ai/chat \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Someone stole $2,000 from my account",
    "language": "en"
  }'

# Check Freshdesk dashboard for new ticket
```

---

## 📊 Logging Configuration

### Winston Log Files

**Locations**:
- `logs/app.log` - All application logs
- `logs/error.log` - Errors only
- `logs/audit.log` - Audit trail (GDPR compliant)

### Log Rotation

```env
MAX_LOG_FILES=10          # Application logs
MAX_ERROR_LOG_FILES=5     # Error logs
MAX_AUDIT_LOG_FILES=20    # Audit logs
```

**Auto-rotation**:
- Max file size: 10MB (app/error), 50MB (audit)
- Old files compressed automatically
- Oldest files deleted when limit reached

### Log Levels

```env
# Production (minimal logging)
LOG_LEVEL=warn

# Staging (moderate logging)
LOG_LEVEL=info

# Development (verbose logging)
LOG_LEVEL=debug
```

### Querying Logs

```bash
# All fraud escalations
grep "AUTO_ESCALATE" logs/audit.log

# Failed login attempts
grep "invalid password" logs/app.log

# Rate limit violations
grep "Rate limit exceeded" logs/app.log

# GDPR requests
grep "GDPR_EXPORT\|ACCOUNT_DELETED" logs/audit.log

# Errors from last hour
tail -n 1000 logs/error.log | grep "$(date +%Y-%m-%d)"
```

### Centralized Logging (Recommended)

**Option 1: ELK Stack**
```bash
# Forward logs to Elasticsearch
filebeat -c filebeat.yml
```

**Option 2: Datadog**
```bash
# Install Datadog agent
DD_API_KEY=<key> DD_SITE="datadoghq.com" bash -c "$(curl -L https://s3.amazonaws.com/dd-agent/scripts/install_script.sh)"
```

**Option 3: Splunk**
- Install Splunk Forwarder
- Configure to monitor `logs/*.log`

---

## ⚡ Rate Limiting Configuration

### Default Limits

```env
RATE_LIMIT_WINDOW_MS=60000           # 1 minute
RATE_LIMIT_MAX_REQUESTS=100          # 100 requests/min
AI_CHAT_RATE_LIMIT=10                # 10 AI messages/min
AUTH_RATE_LIMIT=5                    # 5 login attempts/15min
```

### Scaling Considerations

**High Traffic Apps** (10,000+ users):
```env
RATE_LIMIT_MAX_REQUESTS=500
AI_CHAT_RATE_LIMIT=50
```

**Enterprise** (100,000+ users):
- Use Redis-backed rate limiting
- Install: `npm install rate-limit-redis`
- Configure Redis connection

**Load Balancer**:
- Ensure `X-Forwarded-For` header is passed
- Rate limiting uses client IP (not load balancer IP)

### Testing Rate Limits

```bash
# Test general rate limit (100 req/min)
ab -n 150 -c 10 http://localhost:4000/health

# Test auth rate limit (5 req/15min)
for i in {1..10}; do
  curl -X POST http://localhost:4000/auth/login \
    -H "Content-Type: application/json" \
    -d '{"email":"test@test.com","password":"wrong"}'
  sleep 1
done

# Should see: "Too many login attempts. Try again in 15 minutes."
```

---

## 🔍 Fraud Detection Configuration

### Velocity Checks

```env
FRAUD_VELOCITY_THRESHOLD=5           # Max queries per time window
FRAUD_TIME_WINDOW_MS=3600000         # 1 hour
ENABLE_VELOCITY_CHECKS=true
```

**How It Works**:
1. User sends fraud-related query (e.g., "someone stole money")
2. System tracks timestamp
3. If 5+ queries in 1 hour → flags as suspicious
4. Adds `velocity-suspicious` tag to ticket

**Monitoring**:
```bash
# Check velocity status
curl http://localhost:4000/admin/fraud-velocity

# Check audit logs
grep "velocity-suspicious" logs/audit.log
```

### Keywords

**15 fraud detection keywords** (case-insensitive):
- unauthorized, fraud, scam, hack, steal, stolen, missing, wrong charge, not me, didn't authorize, suspicious, compromised, taken, charged twice, refund

**Add more keywords** (`backend/index.js` line ~1850):
```javascript
const fraudKeywords = [
  'unauthorized', 'fraud', 'scam', 'phishing',
  // Add custom keywords here
];
```

---

## 🛡️ GDPR Compliance

### User Data Export

**Endpoint**: `GET /gdpr/export`

**Response**:
```json
{
  "user": { "id": "...", "email": "..." },
  "wallets": [ ... ],
  "transactions": [ ... ],
  "virtualCards": [ ... ],
  "kycData": { ... },
  "supportTickets": [ ... ],
  "devices": [ ... ],
  "exportedAt": "2026-02-18T12:00:00.000Z"
}
```

**Automation**:
- Supports automated export requests
- JSON format (easy integration)
- Includes all user data

### Account Deletion

**Endpoint**: `DELETE /gdpr/delete-account`

**Process**:
1. User confirms email + password
2. Account anonymized (not deleted)
3. Email → `deleted-{userId}@egwallet.deleted`
4. Status → `deleted`
5. KYC data → `[DELETED]`
6. Cards marked as deleted
7. Audit log created

**Why Anonymize?**:
- Legal requirement (financial regulations)
- Transaction history must be preserved
- Anonymization satisfies GDPR

### Consent Management

**Endpoint**: `GET /gdpr/consent`, `POST /gdpr/consent`

**Consent Types**:
```json
{
  "marketing": true,
  "analytics": false,
  "dataProcessing": true,
  "thirdPartySharing": false
}
```

---

## 📈 Monitoring & Alerts

### Health Checks

**Basic**:
```bash
curl http://localhost:4000/health
```

**Detailed**:
```bash
curl http://localhost:4000/admin/health/detailed
```

**Response**:
```json
{
  "status": "healthy",
  "uptime": 86400,
  "memory": { "used": "120 MB", "total": "512 MB" },
  "database": {
    "users": 5000,
    "wallets": 7500,
    "transactions": 50000
  },
  "integrations": {
    "freshdesk": true
  }
}
```

### Monitoring Dashboards

**Option 1: Prometheus + Grafana**
```javascript
// Add to backend/index.js
const promClient = require('prom-client');
const register = new promClient.Registry();

app.get('/metrics', (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(register.metrics());
});
```

**Option 2: Datadog**
- Install DD agent
- Auto-discovers Express app
- Dashboard available at app.datadoghq.com

**Option 3: New Relic**
```bash
npm install newrelic
```

### Alert Rules (Recommended)

| Metric | Threshold | Action |
|--------|-----------|--------|
| Error rate | >5 errors/min | Page on-call engineer |
| Response time | >2 seconds (p95) | Investigate performance |
| Rate limit hits | >100/min | Check for DDoS |
| Freshdesk sync failures | >10/hour | Check API key |
| Memory usage | >80% | Scale up server |
| Disk usage | >90% | Clean old logs |
| Fraud velocity alerts | >5/hour | Manual review |

---

## 🚀 Deployment Platforms

### Railway

**Quick Deploy**:
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Deploy
railway up
```

**Environment Variables**:
```bash
railway variables set JWT_SECRET=<secret>
railway variables set FRESHDESK_DOMAIN=<domain>
railway variables set FRESHDESK_API_KEY=<key>
railway variables set ALLOWED_ORIGINS=https://app.egwallet.com
```

**Database Persistence**:
```toml
# railway.toml
[deploy]
healthcheckPath = "/healthz"

[build]
builder = "NIXPACKS"
buildCommand = "npm install"

[[volumes]]
name = "data"
mountPath = "/app/backend/data"
```

### Heroku

```bash
# Login
heroku login

# Create app
heroku create egwallet-backend

# Set environment variables
heroku config:set JWT_SECRET=<secret>
heroku config:set FRESHDESK_DOMAIN=<domain>
heroku config:set FRESHDESK_API_KEY=<key>

# Deploy
git push heroku main

# View logs
heroku logs --tail
```

### AWS EC2

**1. Launch EC2 Instance**:
- Ubuntu 22.04 LTS
- t3.small (2 vCPU, 2 GB RAM)
- Security Group: Allow 4000, 22, 80, 443

**2. Install Node.js**:
```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**3. Setup App**:
```bash
git clone https://github.com/yourcompany/egwallet.git
cd egwallet/backend
npm install
cp .env.example .env
nano .env  # Configure
```

**4. Setup PM2**:
```bash
sudo npm install -g pm2
pm2 start index.js --name egwallet-backend
pm2 save
pm2 startup
```

**5. Setup Nginx**:
```nginx
# /etc/nginx/sites-available/egwallet
server {
    listen 80;
    server_name api.egwallet.com;

    location / {
        proxy_pass http://localhost:4000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/egwallet /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

**6. SSL Certificate**:
```bash
sudo apt-get install certbot python3-certbot-nginx
sudo certbot --nginx -d api.egwallet.com
```

### Docker

**Dockerfile**:
```dockerfile
FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

EXPOSE 4000

CMD ["node", "index.js"]
```

**docker-compose.yml**:
```yaml
version: '3.8'
services:
  backend:
    build: ./backend
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=production
      - JWT_SECRET=${JWT_SECRET}
      - FRESHDESK_DOMAIN=${FRESHDESK_DOMAIN}
      - FRESHDESK_API_KEY=${FRESHDESK_API_KEY}
    volumes:
      - ./backend/db.json:/app/db.json
      - ./backend/logs:/app/logs
    restart: unless-stopped
```

**Deploy**:
```bash
docker-compose up -d
docker-compose logs -f backend
```

---

## 🔧 Production Checklist

### Pre-Launch

- [ ] JWT secrets generated (32+ chars)
- [ ] Freshdesk configured & tested
- [ ] ALLOWED_ORIGINS set to production domains
- [ ] NODE_ENV=production
- [ ] LOG_LEVEL=warn
- [ ] Helmet enabled (ENABLE_HELMET=true)
- [ ] Rate limits configured for scale
- [ ] Health check returns 200 OK
- [ ] Logs directory created (`mkdir -p logs`)
- [ ] Database backup tested (`cp db.json db.json.bak`)
- [ ] GDPR endpoints tested
- [ ] Fraud detection tested
- [ ] SSL certificate installed
- [ ] Monitoring dashboard configured
- [ ] Alert rules set up

### Post-Launch

- [ ] Monitor error logs for first 24 hours
- [ ] Check Freshdesk tickets syncing
- [ ] Verify rate limiting working
- [ ] Test GDPR data export
- [ ] Review audit logs
- [ ] Monitor memory usage
- [ ] Check fraud velocity alerts
- [ ] Test mobile app integration
- [ ] Load test API endpoints
- [ ] Disaster recovery plan documented

---

## 📞 Support & Maintenance

### Daily Tasks
- Check error logs: `tail -f logs/error.log`
- Monitor Freshdesk queue
- Review fraud velocity alerts

### Weekly Tasks
- Rotate logs (automatic via Winston)
- Check disk space: `df -h`
- Review security patches: `npm audit`

### Monthly Tasks
- Update dependencies: `npm update`
- Backup database: `cp db.json backups/db-$(date +%Y%m%d).json`
- Review rate limit thresholds
- Audit GDPR requests

### Emergency Contacts
- **Security Issues**: security@egwallet.com
- **Downtime**: oncall@egwallet.com
- **GDPR Requests**: compliance@egwallet.com

---

## 🎯 Performance Tuning

### Node.js Optimization

```bash
# Increase memory limit (4GB)
node --max-old-space-size=4096 index.js

# Enable clustering (multi-core)
pm2 start index.js -i max
```

### Database Optimization

**Current**: JSON file (`db.json`)

**Upgrade Path** (when >100,000 users):
1. PostgreSQL for transactions
2. Redis for sessions/cache
3. Elasticsearch for logs

### Caching

**Install Redis**:
```bash
npm install redis
```

**Cache expensive queries**:
```javascript
const redis = require('redis');
const client = redis.createClient();

// Cache user data (5 min TTL)
app.get('/users/:id', async (req, res) => {
  const cached = await client.get(`user:${req.params.id}`);
  if (cached) return res.json(JSON.parse(cached));
  
  const user = db.users.find(u => u.id === req.params.id);
  await client.setEx(`user:${req.params.id}`, 300, JSON.stringify(user));
  res.json(user);
});
```

---

**Status**: ✅ **Production Ready**  
**Last Updated**: February 18, 2026  
**Deployment Version**: 1.0.0
