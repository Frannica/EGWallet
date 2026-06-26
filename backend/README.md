# EGWallet Mock Backend

This is a tiny mock backend for development and testing of the EGWalletSimple app.

Run:

```powershell
cd mock-backend
npm install
npm start
```

API endpoints:
- `POST /auth/register` {email, password, region}
- `POST /auth/login` {email, password}
- `GET /wallets/:id/balance` (Bearer token)
- `GET /wallets/:id/transactions` (Bearer token)
- `POST /transactions` (Bearer token) {fromWalletId, toWalletId, amount, currency, memo}

Note: `amount` is expressed in minor units (integer). For example, USD $1.23 should be sent as `123`.
- `GET /rates`
- `GET /me` (Bearer token)

Notes:
- Data is persisted to `db.json` in this folder. This is intentionally simple for local testing.
- JWT secret is `dev_secret_change_me` by default. Set `JWT_SECRET` env var to override.

## PostgreSQL Phase 0 Tooling

Phase 0 adds schema + import/parity tooling only. Runtime still uses `db.json`.

Runbook: `docs/postgres-phase0-runbook.md`

Quick commands:

```powershell
npm run db:migrate
npm run db:import -- --file .\db.proof-test.json
npm run db:parity -- --file .\db.proof-test.json --strict
npm run test:db:phase0
```
