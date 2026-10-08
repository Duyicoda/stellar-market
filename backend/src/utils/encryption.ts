import crypto from "crypto";
import { config } from "../config";

/**
 * AES-256-GCM authenticated encryption.
 *
 * Format: <ivHex>:<authTagHex>:<ciphertextHex>
 *
 * The 16-byte auth tag is verified before any plaintext is returned, so
 * tampered ciphertext throws instead of silently producing garbage.
 *
 * Migration note: the decrypt function detects the legacy AES-256-CBC format
 * (iv:ciphertext — no auth tag field) and falls back to CBC decryption so
 * existing encrypted values continue to work.  New writes always use GCM.
 */

const ALGORITHM_GCM = "aes-256-gcm";
const ALGORITHM_CBC = "aes-256-cbc"; // kept for backward-compatible reads only
const GCM_IV_BYTES = 12; // 96-bit IV recommended for GCM

function getKey(): Buffer {
  return Buffer.from(config.encryptionKey, "hex");
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(GCM_IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM_GCM, getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(":");

  if (parts.length === 3) {
    // GCM format: iv:authTag:ciphertext
    const [ivHex, tagHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const encrypted = Buffer.from(cipherHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM_GCM, getKey(), iv);
    decipher.setAuthTag(tag);
    // If the tag doesn't match, createDecipheriv will throw — tampered data is rejected.
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  }

  // Legacy CBC format: iv:ciphertext — backward-compatible reads only
  if (parts.length === 2) {
    const [ivHex, cipherHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const encrypted = Buffer.from(cipherHex, "hex");
    const decipher = crypto.createDecipheriv(ALGORITHM_CBC, getKey(), iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString("utf8");
  }

  throw new Error("Invalid encrypted text format");
}
