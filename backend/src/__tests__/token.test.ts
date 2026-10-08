/**
 * Tests for #1435: the token crypto helpers in `src/utils/token.ts`.
 *
 * `generateToken()` and `hashToken()` guard every password-reset, email
 * verification and refresh-token link the API mails out. Both are pure and
 * deterministic, so a regression here (a truncated byte length, a swapped
 * digest algorithm, a `hex` encoding swapped for `base64`) would silently weaken
 * every token in the system and would not surface anywhere except as a
 * downstream "link has expired" failure.
 *
 * The assertions below are deliberately written as invariants rather than
 * re-implementations of the source: the exact SHA-256 digests are pinned as
 * known-answer vectors, so a change of algorithm or output encoding cannot
 * silently pass, while length/uniqueness/uniqueness-over-samples is checked
 * across a batch rather than one draw from the RNG.
 */

import crypto from "crypto";
import { generateToken, hashToken } from "../utils/token";

// ─── Helpers ───────────────────────────────────────────────────────────────────

const HEX_64 = /^[0-9a-f]{64}$/;

/** Canonical SHA-256 known-answer vectors (FIPS 180-4 / NIST examples). */
const SHA256_KNOWN_ANSWERS: ReadonlyArray<readonly [string, string]> = [
  ["", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  ["abc", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"],
  [
    "stellar-market",
    "3a811a7f81b08640db0bf616dfb3c3ee36aa73ada53b08bac942feccaec2d990",
  ],
  [
    "a".repeat(1000),
    "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
  ],
];

// ─── generateToken (#1435) ────────────────────────────────────────────────────

describe("generateToken (#1435)", () => {
  it("returns a 64-character lowercase hex string", () => {
    expect(generateToken()).toMatch(HEX_64);
  });

  it("returns 32 bytes of entropy, not a shorter token", () => {
    // 64 hex characters must decode to exactly 32 bytes (256 bits). A silently
    // shortened `randomBytes(n)` call would still be "a hex string" but would
    // quietly cut the token's entropy in half.
    expect(Buffer.from(generateToken(), "hex")).toHaveLength(32);
  });

  it("returns a different token on every call", () => {
    expect(generateToken()).not.toBe(generateToken());
  });

  it("does not repeat across a large batch of draws", () => {
    // With 256 bits of entropy the birthday-bound collision probability over
    // 1000 draws is ~2^-137, so any collision here is a real defect (e.g. the
    // RNG being stubbed, seeded, or replaced with a constant) rather than bad
    // luck.
    const SAMPLE_SIZE = 1000;
    const tokens = new Set<string>();
    for (let i = 0; i < SAMPLE_SIZE; i += 1) {
      tokens.add(generateToken());
    }

    expect(tokens.size).toBe(SAMPLE_SIZE);
  });

  it("produces only hex characters across a large batch", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(generateToken()).toMatch(HEX_64);
    }
  });
});

// ─── hashToken (#1435) ────────────────────────────────────────────────────────

describe("hashToken (#1435)", () => {
  it("returns a 64-character lowercase hex string", () => {
    expect(hashToken("some-raw-token")).toMatch(HEX_64);
  });

  it("is deterministic for the same input", () => {
    const token = "repeat-me-please";

    expect(hashToken(token)).toBe(hashToken(token));
  });

  it.each(SHA256_KNOWN_ANSWERS)(
    "hashes %j to the canonical SHA-256 digest",
    (input, expected) => {
      // Pins the algorithm and the output encoding. A change to SHA-512,
      // base64, or a truncated digest fails here even though it would still
      // produce "a deterministic hash of the right shape".
      expect(hashToken(input)).toBe(expected);
    },
  );

  it("returns different digests for different inputs", () => {
    expect(hashToken("token-a")).not.toBe(hashToken("token-b"));
  });

  it("is not case-insensitive, so distinct tokens stay distinct", () => {
    expect(hashToken("Token")).not.toBe(hashToken("token"));
  });

  it("handles multi-byte UTF-8 input", () => {
    const input = "pässwörd-🔐-令牌";
    const expected = crypto
      .createHash("sha256")
      .update(input, "utf8")
      .digest("hex");

    expect(hashToken(input)).toBe(expected);
  });

  it("hashes the empty string without throwing", () => {
    expect(hashToken("")).toBe(SHA256_KNOWN_ANSWERS[0][1]);
  });

  it("does not leak the raw token", () => {
    const raw = generateToken();

    // Only the hash is ever persisted, so the stored value must not be
    // recoverable by reading the digest back.
    const digest = hashToken(raw);
    expect(digest).not.toBe(raw);
    expect(Buffer.from(digest, "hex").toString("utf8")).not.toContain(raw);
  });

  it("maps distinct generated tokens to distinct digests", () => {
    const digests = new Set(Array.from({ length: 100 }, () => hashToken(generateToken())));

    expect(digests.size).toBe(100);
  });
});
