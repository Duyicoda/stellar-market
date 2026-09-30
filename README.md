# StellarMarket

A decentralized freelance marketplace built on **Stellar/Soroban**, enabling trustless work agreements with escrow payments, on-chain reputation, and decentralized dispute resolution.

## Overview

StellarMarket connects freelancers and clients through a transparent, blockchain-powered platform. Smart contracts handle payment escrow, milestone tracking, and dispute arbitration — eliminating the need for centralized intermediaries.

## Architecture

```
stellar-market/
├── frontend/       # Next.js marketplace UI
├── backend/        # Express.js API server
├── contracts/      # Soroban smart contracts (Rust)
│   ├── escrow/     # Job escrow & milestone payments
│   ├── reputation/ # On-chain reputation & staking
│   └── dispute/    # Dispute arbitration system
└── docs/           # Documentation
```

## Tech Stack

| Layer               | Technology                                        |
| ------------------- | ------------------------------------------------- |
| **Frontend**        | Next.js 16, TypeScript, Tailwind CSS, Stellar SDK |
| **Backend**         | Express.js, TypeScript, PostgreSQL, Prisma ORM    |
| **Smart Contracts** | Soroban SDK, Rust                                 |
| **Blockchain**      | Stellar Network (Soroban)                         |

## Features

- **Job Marketplace** — Post, browse, and apply for freelance jobs
- **Escrow Payments** — Funds locked in smart contracts, released on milestone completion
- **Milestone Tracking** — Break jobs into milestones with individual escrow releases
- **On-Chain Reputation** — Rating system backed by stake-weighted reviews
- **Dispute Resolution** — Decentralized arbitration with voter panels
- **Messaging** — In-app communication between clients and freelancers
- **Multi-Token Support** — Pay in XLM or any Stellar asset

## Getting Started

### Prerequisites

- Node.js >= 18
- Rust & Cargo
- Soroban CLI
- PostgreSQL

### Installation

```bash
# Clone the repository
git clone https://github.com/stellarmarket-labs/stellar-market.git
cd stellar-market

# Install frontend dependencies
cd frontend && npm install

# Install backend dependencies
cd ../backend && npm install

# Build smart contracts
cd ../contracts/escrow && cargo build --release --target wasm32-unknown-unknown
```

### Environment Setup

Before running the application, configure environment variables for each package:

#### Backend

Copy `backend/.env.example` to `backend/.env` and configure:

```bash
cd backend
cp .env.example .env
```

Required variables:

- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET` — Token signing secret
- `STELLAR_NETWORK_PASSPHRASE`, `STELLAR_RPC_URL`, `STELLAR_HORIZON_URL`
- Contract IDs: `ESCROW_CONTRACT_ID`, `DISPUTE_CONTRACT_ID`, `REPUTATION_CONTRACT_ID`
- `REDIS_URL` (optional, mocked in tests)
- `ENCRYPTION_KEY` — 64-character hex string (required in CI)

#### Contracts

Copy `contracts/.env.example` to `contracts/.env` for deployment:

```bash
cd contracts
cp .env.example .env
```

Required variables:

- `STELLAR_NETWORK` — Network name in Stellar CLI (e.g., `testnet`)
- `SOURCE_ACCOUNT` — CLI identity for deployments
- `TOKEN_ADDRESS` — Token contract address

#### Frontend

Set `NEXT_PUBLIC_BACKEND_URL` environment variable at build time:

```bash
cd frontend
echo "NEXT_PUBLIC_BACKEND_URL=http://localhost:3001" > .env.local
```

### Development

```bash
# Start backend server
cd backend && npm run dev

# Start frontend dev server
cd frontend && npm run dev
```

### Post-Deploy Verification

After applying backend migrations, verify persisted user review aggregates with:

```bash
cd backend && npm run prisma:verify-review-aggregates
```

The query returns only mismatches between stored `User.averageRating` / `User.reviewCount`
and values recomputed from the `Review` table. The command prints `No review aggregate
mismatches found.` when everything is consistent; otherwise it prints the mismatched users
and exits non-zero.

## API Rate Limiting

The API enforces rate limits to prevent abuse and ensure fair usage:

| Endpoint                       | Limit        | Window   | Key                    |
| ------------------------------ | ------------ | -------- | ---------------------- |
| `/api/v1/*` (global)           | 100 requests | 1 minute | IP address             |
| `/api/v1/auth/login`           | 10 requests  | 1 minute | IP address             |
| `/api/v1/auth/register`        | 10 requests  | 1 minute | IP address             |
| `POST /api/v1/jobs`            | 30 requests  | 1 hour   | User ID (fallback: IP) |
| `POST /api/v1/reviews`         | 30 requests  | 1 hour   | User ID (fallback: IP) |
| `POST /api/v1/disputes`        | 30 requests  | 1 hour   | User ID (fallback: IP) |
| `/api/v1/auth/forgot-password` | 3 requests   | 1 hour   | IP address             |

When a limit is exceeded, the API returns `429 Too Many Requests` with a `Retry-After` header indicating seconds until the limit resets.

## Contributing

We welcome contributions! Please see our [Contributing Guide](docs/CONTRIBUTING.md) for details.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
