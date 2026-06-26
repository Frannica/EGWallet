# PostgreSQL Phase 0 Runbook

## Purpose

Phase 0 introduces PostgreSQL schema and offline `db.json` import/parity tooling only.

## Non-goals

- Do not switch runtime persistence away from `db.json`.
- Do not change API route behavior.
- Do not change wallet/payment business logic.
- Do not change mobile or AAB workflows.

## Prerequisites

- Node.js 18+
- PostgreSQL instance available
- `DATABASE_URL` exported for local shell session
- Existing source JSON snapshot available (`db.proof-test.json` or production snapshot)

## Environment

Set local environment variables:

```powershell
$env:DATABASE_URL="postgres://postgres:postgres@localhost:5432/egwallet_phase0"
```

Optional:

```powershell
$env:PG_POOL_MAX="10"
$env:PGSSLMODE="disable"
```

## Execution Order

Run from `backend/`:

```powershell
npm install
npm run db:migrate
npm run db:migrate
npm run db:import -- --file .\db.proof-test.json
npm run db:parity -- --file .\db.proof-test.json --strict
npm run test:db:phase0
```

## Expected Results

- `db:migrate` first run applies migration(s), second run skips already applied versions.
- `db:import` prints per-table inserted rows and exits with code 0.
- `db:parity --strict` prints PASS and exits with code 0.
- `test:db:phase0` exits with code 0.

## Stop Conditions

Stop and investigate immediately if any occur:

- `db:migrate` is not idempotent.
- `db:import` reports partial writes (should rollback on failure).
- `db:parity --strict` reports mismatches.
- Tests fail.

## Rollback Checklist

Because Phase 0 is runtime-additive only, rollback is straightforward:

1. Revert Phase 0 branch/commit set if code-level issue is found.
2. Drop and recreate local/staging PostgreSQL database used for rehearsal.
3. Restore PostgreSQL from pre-run dump if needed.
4. Keep production runtime on `db.json` (no runtime switch in Phase 0).

## Promotion Gate To Next Phase

Before Phase 1:

- All commands above pass on a clean database.
- Import re-run safety validated (fails without `--truncate`).
- Rollback steps tested by another engineer.
- Scope confirmation: no runtime switch merged.
