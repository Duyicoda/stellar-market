import {
  castVoteSchema,
  confirmDisputeTransactionSchema,
  resolveDisputeSchema,
} from "../schemas/dispute";

const long = "x".repeat(2001);
const ok = "x".repeat(2000);

describe("dispute schema length caps (#1377)", () => {
  it("castVoteSchema rejects oversized reason, accepts valid", () => {
    expect(castVoteSchema.safeParse({ choice: "CLIENT", reason: long }).success).toBe(false);
    expect(castVoteSchema.safeParse({ choice: "CLIENT", reason: ok }).success).toBe(true);
  });

  it("confirmDisputeTransactionSchema rejects oversized reason", () => {
    const base = { hash: "h", type: "t", jobId: "j", onChainDisputeId: "1", respondentId: "r" };
    expect(confirmDisputeTransactionSchema.safeParse({ ...base, reason: long }).success).toBe(false);
    expect(confirmDisputeTransactionSchema.safeParse({ ...base, reason: ok }).success).toBe(true);
  });

  it("resolveDisputeSchema rejects oversized outcome", () => {
    expect(resolveDisputeSchema.safeParse({ outcome: long }).success).toBe(false);
    expect(resolveDisputeSchema.safeParse({ outcome: ok }).success).toBe(true);
  });
});
