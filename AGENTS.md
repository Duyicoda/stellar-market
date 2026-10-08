# StellarMarket — Agent Guide

## Project Structure

Monorepo with three independent packages:

| Package | Path | Stack |
|---------|------|-------|
| Frontend | `frontend/` | Next.js 14+, TypeScript, Tailwind CSS, Stellar SDK |
| Backend | `backend/` | Express.js, TypeScript, PostgreSQL, Prisma ORM |
| Contracts | `contracts/` | Soroban SDK 21.7.5, Rust (wasm32) |

## Essential Commands

### Backend
```bash
cd backend
npm install          # Runs prisma generate via postinstall
npm run dev          # ts-node-dev with hot reload
npm run build        # tsc
npm test             # Jest (requires ENCRYPTION_KEY env var in CI)
npm run prisma:generate
npm run prisma:migrate
npm run prisma:verify-review-aggregates  # Post-migration verification
```

### Frontend
```bash
cd frontend
npm install          # Use --legacy-peer-deps if prompted
npm run dev          # Next.js dev server
npm run build        # Production build (requires NEXT_PUBLIC_BACKEND_URL)
npm run lint         # ESLint
npm test             # Jest with jsdom
npm run test:e2e     # Playwright e2e tests
```

### Contracts
```bash
cd contracts
cargo build --release --target wasm32-unknown-unknown   # Build all contracts
cargo test                                                    # Run all tests
cargo test -p stellar-market-dispute                         # Run single package tests
cargo test -p stellar-market-integration-tests                # Integration tests
cargo test --lib fuzz:: -- --test-threads=1 --nocapture      # Fuzz tests (escrow only)
```

**Rust toolchain**: 1.94.1 with `wasm32-unknown-unknown` target (see `contracts/rust-toolchain.toml`).

## Testing Patterns

### Backend (Jest)
- Test files: `src/__tests__/**/*.test.ts`
- Setup: `jest.setup.ts` mocks Redis modules (RedisClient, BullMQ, rate-limiter) to prevent TCP connections
- Tests run in band (`--runInBand`) to avoid module isolation issues
- Transform ignores: `@scure`, `@otplib`, `otplib` excluded from ignore patterns

### Frontend (Jest)
- Test files: `src/__tests__/**/*.test.tsx` and `*.test.ts`
- Setup: `jest.setup.ts` polyfills SubtleCrypto (realm-bridge fix #880), structuredClone, IntersectionObserver
- CSS modules mocked via `__mocks__/styleMock.ts`
- E2E tests use Playwright: `npm run test:e2e`

### Contracts (Cargo)
- Unit tests in `src/test.rs` and `src/test_append.rs` (snapshot-based)
- Integration tests: `contracts/integration-tests/tests/`
- Test snapshots stored in `test_snapshots/` directories
- Fuzz tests exist only in escrow contract, run single-threaded
- Tests require `testutils` feature of soroban-sdk

## Environment Setup

### Backend
Copy `backend/.env.example` to `backend/.env`. Required vars:
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — Token signing secret
- `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`
- Contract IDs: `ESCROW_CONTRACT_ID`, `DISPUTE_CONTRACT_ID`, `REPUTATION_CONTRACT_ID`
- `REDIS_URL` (optional, mocked in tests)
- `ENCRYPTION_KEY` — 64-char hex string (required in CI)

### Contracts
Copy `contracts/.env.example` to `contracts/.env`. Required for deployment:
- `STELLAR_NETWORK` — Network name in Stellar CLI (e.g., `testnet`)
- `SOURCE_ACCOUNT` — CLI identity for deployments
- `TOKEN_ADDRESS` — Token contract address

### Frontend
Requires `NEXT_PUBLIC_BACKEND_URL` env var at build time.

## CI Pipeline

GitHub Actions (`.github/workflows/ci.yml`) runs three parallel tracks:
1. **Backend**: build → test (needs ENCRYPTION_KEY)
2. **Frontend**: build → test (uses `--legacy-peer-deps`)
3. **Contracts**: build → test → fuzz tests (1000+ iterations, single-threaded)

## Key Architecture Notes

- **Contract workspace** (`contracts/Cargo.toml`): members are `escrow`, `reputation`, `reputation_interface`, `dispute`, `integration-tests`
- **Cross-contract communication**: Uses `ReputationVerifier` trait from `reputation_interface/` crate
- **Backend routes**: `src/routes/` — 30+ route files organized by domain
- **Frontend app**: `src/app/` — Next.js App Router structure
- **Prisma schema**: 840+ lines, handles users, jobs, milestones, reviews, disputes, messages, notifications

## Known Gotchas

- Contract test snapshots in `test_snapshots/` directories — update them if contract state structs change
- Backend Redis mocking is critical — tests will fail with ECONNREFUSED if mocks are removed
- Frontend SubtleCrypto polyfill uses Node's `webcrypto` with a realm-bridge wrapper (see issue #880)
- Dispute contract `lib.rs` is 2500+ lines — use `grep` to locate functions before editing
- Backend `postinstall` runs `prisma generate` automatically — don't skip `npm install`

## Contract Addresses

Deployed contract IDs are tracked in `contracts/ADDRESSES.md`. After deploying, update this file.
