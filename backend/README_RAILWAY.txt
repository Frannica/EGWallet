Railway deploy notes:
- Start command: npm start
- Health check: /health

Required env vars:
- JWT_SECRET       (required, 32+ chars in production)
- PORT             (auto-set by Railway)
- DATABASE_URL     (required — PostgreSQL is the only supported runtime database)

Deposit provider (Stripe — production):
- STRIPE_SECRET_KEY        (sk_live_… in production)
- STRIPE_PUBLISHABLE_KEY   (pk_live_… in production)
- STRIPE_WEBHOOK_SECRET    (required whenever STRIPE_SECRET_KEY is set)

Payout provider (production — routed by withdrawal country):
- Africa (NG, GH, KE, CM, SN, CI, ZA, etc.) → Kora:
    KORA_LIVE_PUBLIC_KEY       (pk_live_…)
    KORA_LIVE_SECRET_KEY       (sk_live_…)
    KORA_LIVE_ENCRYPTION_KEY   (optional — 32-byte AES-256-GCM payload encryption key)
    NOTE: Kora does not issue a separate webhook secret — there is no
    KORA_WEBHOOK_SECRET var. Webhooks are HMAC-signed with KORA_LIVE_SECRET_KEY
    itself (see https://developers.korapay.com/docs/webhooks). You must still set
    the webhook URL on the Kora dashboard (Settings → API Configuration →
    Notification URLs) to https://<your-host>/webhooks/kora.
- Everything else → Stripe Connect:
    STRIPE_CONNECT_READY=true
    STRIPE_CONNECT_ACCOUNT     (acct_… destination for user payouts)

If a region's provider is not configured, production withdrawals for that region are
rejected at request time (see isPayoutProviderReady in backend/payoutProviders.js) rather
than silently simulated.
