import dotenv from "dotenv";
import { version } from "../../package.json";

dotenv.config();

const configuredPlatformMinimum = Number(process.env.PLATFORM_MIN_BUDGET_XLM || "1");
const platformMinBudgetXlm =
  Number.isFinite(configuredPlatformMinimum) && configuredPlatformMinimum > 0
    ? configuredPlatformMinimum
    : 1;

export const MAX_PAGE_SIZE = 100;

// Validate encryption key at startup
function validateEncryptionKey(key: string): void {
  if (!key) {
    throw new Error(
      "ENCRYPTION_KEY is required. Please set it to a 64-character hex string (32 bytes)."
    );
  }
  if (key.length !== 64) {
    throw new Error(
      `ENCRYPTION_KEY must be exactly 64 characters (got ${key.length}). It should be a 64-character hex string (32 bytes).`
    );
  }
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "ENCRYPTION_KEY must be a valid hex string (only characters 0-9, a-f, A-F are allowed)."
    );
  }
}

// Validate encryption key at module load time
const encryptionKey = process.env.ENCRYPTION_KEY || "";
validateEncryptionKey(encryptionKey);

// Validate NATIVE_TOKEN_ID at startup — a missing or malformed value causes
// every escrow creation call to throw deep inside Address parsing, with no
// indication that a config var is the root cause.
function validateNativeTokenId(value: string | undefined): string {
  if (!value) {
    throw new Error(
      "NATIVE_TOKEN_ID is required. Please set it to the 56-character Stellar contract address for the native token."
    );
  }
  // Stellar C-strkey contract addresses are exactly 56 characters and start with 'C'
  if (!/^C[A-Z2-7]{55}$/.test(value)) {
    throw new Error(
      `NATIVE_TOKEN_ID must be a valid 56-character Stellar contract address starting with 'C' (got "${value}").`
    );
  }
  return value;
}

const nativeTokenId = validateNativeTokenId(process.env.NATIVE_TOKEN_ID);

export const config = {
  version,
  port: process.env.PORT || 5000,
  jwtSecret: process.env.JWT_SECRET || "default-secret-change-me",
  databaseUrl: process.env.DATABASE_URL,
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  encryptionKey,
  corsAllowedOrigins: (process.env.CORS_ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  // The minimum is kept server-side so clients cannot create zero-value jobs
  // by bypassing the posting form.
  platformMinBudgetXlm,
  evidenceStorage: {
    bucket: process.env.EVIDENCE_S3_BUCKET || "",
    region: process.env.EVIDENCE_S3_REGION || process.env.AWS_REGION || "us-east-1",
    endpoint: process.env.EVIDENCE_S3_ENDPOINT || undefined,
    forcePathStyle: process.env.EVIDENCE_S3_FORCE_PATH_STYLE === "true",
  },
  stellar: {
    networkPassphrase: process.env.STELLAR_NETWORK_PASSPHRASE || "Test SDF Network ; September 2015",
    rpcUrl: process.env.STELLAR_RPC_URL || "https://soroban-testnet.stellar.org",
    secondaryRpcUrl: process.env.STELLAR_SECONDARY_RPC_URL || "https://soroban-testnet.stellar.org/secondary",
    horizonUrl: process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org",
    escrowContractId: process.env.ESCROW_CONTRACT_ID || "",
    disputeContractId: process.env.DISPUTE_CONTRACT_ID || "",
    reputationContractId: process.env.REPUTATION_CONTRACT_ID || "",
    nativeTokenId,
    keeperSecretKey: process.env.KEEPER_SECRET_KEY || "",
  },
  smtp: {
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    user: process.env.SMTP_USER || "",
    pass: process.env.SMTP_PASS || "",
    from: process.env.SMTP_FROM || "noreply@stellarmarket.io",
  },
  email: {
    // "brevo" sends via Brevo's HTTP API (just an API key, no SMTP login);
    // anything else falls back to the smtp block above via nodemailer.
    provider: process.env.EMAIL_SERVICE_PROVIDER || "smtp",
    apiKey: process.env.EMAIL_SERVICE_API_KEY || "",
    fromAddress: process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_FROM || "noreply@stellarmarket.io",
    fromName: process.env.EMAIL_FROM_NAME || "StellarMarket",
  },
  vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
  vapidSubject: process.env.VAPID_SUBJECT || "mailto:admin@stellarmarket.io",
};
