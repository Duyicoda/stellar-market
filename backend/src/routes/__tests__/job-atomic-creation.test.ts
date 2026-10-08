import request from "supertest";
import express from "express";
import jwt from "jsonwebtoken";
import { config } from "../../config";

// ─── Mocks ────────────────────────────────────────────────────────────────────
// Atomic job+milestone creation (#1125). The handler runs its writes inside
// `prisma.$transaction(cb)`; the mock invokes the callback with a `tx` that has
// `job.create`, so a single rejection from `job.create` models a mid-sequence
// failure that rolls the whole thing back (nothing persisted, nothing returned).
jest.mock("@prisma/client", () => {
  const mockPrisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ role: "CLIENT", emailVerified: true }),
    },
    job: {
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  };

  class PrismaClientKnownRequestError extends Error {
    code: string;
    constructor(message: string, opts: { code: string }) {
      super(message);
      this.code = opts.code;
    }
  }

  return {
    PrismaClient: jest.fn(() => mockPrisma),
    Prisma: { PrismaClientKnownRequestError },
    JobStatus: { OPEN: "OPEN" },
  };
});

jest.mock("../../lib/cache", () => ({
  cache: jest.fn(),
  invalidateCache: jest.fn(),
  invalidateCacheKey: jest.fn(),
  generateJobsCacheKey: jest.fn(() => "key"),
  generateJobCacheKey: jest.fn(() => "key"),
  generateJobOnChainStatusCacheKey: jest.fn(() => "key"),
}));

jest.mock("../../services/recommendation-queue.service", () => ({
  RecommendationQueueService: { enqueueRebuild: jest.fn() },
}));

jest.mock("../../services/fraud-detection.service", () => ({
  FraudDetectionService: { onJobCreated: jest.fn() },
}));

jest.mock("../../services/contract.service", () => ({
  ContractService: {},
}));

jest.mock("../../socket", () => ({ getIo: jest.fn(() => ({ emit: jest.fn() })) }));

import { PrismaClient, Prisma } from "@prisma/client";
import jobRouter from "../job.routes";
import { errorHandler } from "../../middleware/error";

const prismaMock = new PrismaClient() as unknown as {
  user: { findUnique: jest.Mock };
  job: { findUnique: jest.Mock; create: jest.Mock };
  $transaction: jest.Mock;
};
const jobMock = prismaMock.job;
const userMock = prismaMock.user;
const txMock = prismaMock.$transaction;

const app = express();
app.use(express.json());
app.use("/api/jobs", jobRouter);
app.use(errorHandler);

const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_CLIENT_ID = "00000000-0000-4000-8000-000000000002";

function authHeader(userId = CLIENT_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

const futureDate = (days: number) =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

function baseBody(overrides: Record<string, unknown> = {}) {
  return {
    title: "Build a Soroban DEX frontend",
    description:
      "Develop a responsive Stellar dApp frontend with escrow integration and tests.",
    category: "Frontend",
    skills: ["React", "TypeScript"],
    deadline: futureDate(30),
    paymentToken: "XLM",
    milestones: [
      { title: "Wireframes", description: "Design all screens", amount: 100, dueDate: futureDate(7) },
      { title: "Implementation", description: "Build the components", amount: 200, dueDate: futureDate(14) },
      { title: "Testing", description: "Write the test suite", amount: 150, dueDate: futureDate(21) },
    ],
    ...overrides,
  };
}

/** Make `$transaction(cb)` run the callback against a tx whose job.create is `impl`. */
function wireTransaction(impl: jest.Mock) {
  txMock.mockImplementation(async (cb: (tx: unknown) => unknown) =>
    cb({ job: { create: impl } }),
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  userMock.findUnique.mockResolvedValue({ role: "CLIENT", emailVerified: true });
});

describe("POST /api/jobs/with-milestones — atomic creation (#1125)", () => {
  it("creates the job and all milestones in one transaction and returns 201", async () => {
    const created = {
      id: "job-1",
      title: baseBody().title,
      budget: 450,
      clientId: CLIENT_ID,
      milestones: [{ id: "m1" }, { id: "m2" }, { id: "m3" }],
    };
    const createImpl = jest.fn().mockResolvedValue(created);
    wireTransaction(createImpl);

    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody({ idempotencyKey: "idem-happy-0001" }));

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("job-1");
    // One transaction, one create, three nested milestones.
    expect(txMock).toHaveBeenCalledTimes(1);
    expect(createImpl).toHaveBeenCalledTimes(1);
    const createArg = createImpl.mock.calls[0][0];
    expect(createArg.data.milestones.create).toHaveLength(3);
    // Budget is derived from the milestone amounts (100+200+150), not the client.
    expect(createArg.data.budget).toBe(450);
    // Milestones carry sequential 1-based order.
    expect(createArg.data.milestones.create.map((m: { order: number }) => m.order)).toEqual([1, 2, 3]);
  });

  it("rolls back cleanly on a mid-sequence milestone failure — no partial job returned", async () => {
    // Model the 3rd-of-5 failure: the single transactional create rejects, so
    // nothing is persisted and no job is returned.
    const createImpl = jest.fn().mockRejectedValue(new Error("milestone write failed"));
    wireTransaction(createImpl);

    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody());

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(res.body.id).toBeUndefined();
    expect(txMock).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: retrying with the same key returns the original job, not a duplicate", async () => {
    const original = { id: "job-1", clientId: CLIENT_ID, milestones: [{ id: "m1" }] };

    // First attempt: no existing job, create succeeds.
    jobMock.findUnique.mockResolvedValueOnce(null);
    const createImpl = jest.fn().mockResolvedValue(original);
    wireTransaction(createImpl);

    const first = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody({ idempotencyKey: "idem-retry-0001" }));
    expect(first.status).toBe(201);

    // Retry with the same key: the job now exists → return it, do NOT create again.
    jobMock.findUnique.mockResolvedValueOnce(original);

    const retry = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody({ idempotencyKey: "idem-retry-0001" }));

    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe("job-1");
    // Create was only ever invoked for the first attempt — no duplicate job.
    expect(createImpl).toHaveBeenCalledTimes(1);
  });

  it("resolves a concurrent unique-constraint race (P2002) to the existing job", async () => {
    const existing = { id: "job-1", clientId: CLIENT_ID, milestones: [] };
    // No job found on the pre-check...
    jobMock.findUnique.mockResolvedValueOnce(null);
    // ...but the create loses the race and hits the unique constraint...
    const p2002 = new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
      code: "P2002",
    } as never);
    wireTransaction(jest.fn().mockRejectedValue(p2002));
    // ...so we fetch and return the job the winning request created.
    jobMock.findUnique.mockResolvedValueOnce(existing);

    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody({ idempotencyKey: "idem-race-0001" }));

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("job-1");
  });

  it("returns 409 when the idempotency key belongs to another user", async () => {
    jobMock.findUnique.mockResolvedValueOnce({
      id: "job-1",
      clientId: OTHER_CLIENT_ID,
      milestones: [],
    });

    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody({ idempotencyKey: "idem-someone-else" }));

    expect(res.status).toBe(409);
    expect(txMock).not.toHaveBeenCalled();
  });

  it("returns 403 for a non-client caller", async () => {
    userMock.findUnique.mockResolvedValue({ role: "FREELANCER", emailVerified: true });

    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody());

    expect(res.status).toBe(403);
    expect(txMock).not.toHaveBeenCalled();
  });

  it("returns 422 when the derived budget is below the platform minimum", async () => {
    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(
        baseBody({
          milestones: [
            { title: "Tiny task", description: "A very small task", amount: 0.0000001, dueDate: futureDate(3) },
          ],
        }),
      );

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("BudgetBelowMinimum");
    expect(txMock).not.toHaveBeenCalled();
  });

  it("returns 422 for an unrecognised category", async () => {
    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody({ category: "web3-nonsense" }));

    expect(res.status).toBe(422);
    expect(res.body.code).toBe("InvalidCategory");
    expect(txMock).not.toHaveBeenCalled();
  });

  it("returns 400 when no milestones are provided", async () => {
    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .set(authHeader())
      .send(baseBody({ milestones: [] }));

    expect(res.status).toBe(400);
    expect(txMock).not.toHaveBeenCalled();
  });

  it("requires authentication", async () => {
    const res = await request(app)
      .post("/api/jobs/with-milestones")
      .send(baseBody());
    expect(res.status).toBe(401);
  });
});
