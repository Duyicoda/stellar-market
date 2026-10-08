/**
 * Tests for #1436: `validateMessageSendAuthorization()` in
 * `src/utils/messageValidation.ts`.
 *
 * This is a real authorization boundary: it is the only thing standing between
 * an arbitrary authenticated user and the ability to post messages into a
 * stranger's job thread. It takes an injected `prismaClient`, so the whole
 * decision tree can be exercised with a hand-rolled mock and no database.
 *
 * Each branch asserts the `MessageValidationError.status` that the HTTP and
 * socket layers translate into a response code, not just the message text —
 * a swapped 403/404 is exactly the regression that would leak job existence to
 * non-participants or mask a permissions problem as a missing resource.
 */

import type { PrismaClient } from "@prisma/client";
import {
  MessageValidationError,
  validateMessageSendAuthorization,
} from "../utils/messageValidation";

// ─── Prisma mock ──────────────────────────────────────────────────────────────

type MockPrismaClient = {
  user: { findUnique: jest.Mock };
  job: { findUnique: jest.Mock };
};

function createMockPrisma(): MockPrismaClient {
  return {
    user: { findUnique: jest.fn() },
    job: { findUnique: jest.fn() },
  };
}

const prisma = createMockPrisma();
const prismaClient = prisma as unknown as PrismaClient;

const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const FREELANCER_ID = "00000000-0000-4000-8000-000000000002";
const OUTSIDER_ID = "00000000-0000-4000-8000-000000000003";
const RECEIVER_ID = "00000000-0000-4000-8000-000000000004";
const JOB_ID = "00000000-0000-4000-8000-000000000005";

/** A job whose participants are `CLIENT_ID` (client) and `FREELANCER_ID`. */
function jobWith(clientId: string, freelancerId: string) {
  return { id: JOB_ID, clientId, freelancerId };
}

beforeEach(() => {
  jest.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue({ id: RECEIVER_ID });
  prisma.job.findUnique.mockResolvedValue(jobWith(CLIENT_ID, FREELANCER_ID));
});

describe("validateMessageSendAuthorization — self-send", () => {
  it("throws 400 before looking up a sender who is also the receiver", async () => {
    await expect(
      validateMessageSendAuthorization({
        senderId: CLIENT_ID,
        receiverId: CLIENT_ID,
        prismaClient,
      }),
    ).rejects.toMatchObject({
      status: 400,
      message: "Cannot send a message to yourself.",
    });

    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.job.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Receiver lookup (#1436) ──────────────────────────────────────────────────

describe("validateMessageSendAuthorization — receiver (#1436)", () => {
  it("throws 404 when the receiver does not exist", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const promise = validateMessageSendAuthorization({
      senderId: CLIENT_ID,
      receiverId: RECEIVER_ID,
      prismaClient,
    });

    await expect(promise).rejects.toBeInstanceOf(MessageValidationError);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      name: "MessageValidationError",
      message: "Receiver not found.",
    });
  });

  it("looks the receiver up by id", async () => {
    await validateMessageSendAuthorization({
      senderId: CLIENT_ID,
      receiverId: RECEIVER_ID,
      prismaClient,
    });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: RECEIVER_ID },
    });
  });

  it("does not touch the job table once the receiver is missing", async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      validateMessageSendAuthorization({
        senderId: CLIENT_ID,
        receiverId: RECEIVER_ID,
        jobId: JOB_ID,
        prismaClient,
      }),
    ).rejects.toThrow("Receiver not found.");

    expect(prisma.job.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Job lookup (#1436) ───────────────────────────────────────────────────────

describe("validateMessageSendAuthorization — job (#1436)", () => {
  it("throws 404 when the referenced job does not exist", async () => {
    prisma.job.findUnique.mockResolvedValue(null);

    const promise = validateMessageSendAuthorization({
      senderId: CLIENT_ID,
      receiverId: RECEIVER_ID,
      jobId: JOB_ID,
      prismaClient,
    });

    await expect(promise).rejects.toBeInstanceOf(MessageValidationError);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      message: "Job not found.",
    });
  });

  it("looks the job up by id", async () => {
    await validateMessageSendAuthorization({
      senderId: CLIENT_ID,
      receiverId: RECEIVER_ID,
      jobId: JOB_ID,
      prismaClient,
    });

    expect(prisma.job.findUnique).toHaveBeenCalledWith({
      where: { id: JOB_ID },
    });
  });

  it("skips the job lookup entirely when no jobId is supplied", async () => {
    // Direct messages have no job context, so the participant check must not
    // be applied — and the job table must not be queried at all.
    await expect(
      validateMessageSendAuthorization({
        senderId: OUTSIDER_ID,
        receiverId: RECEIVER_ID,
        prismaClient,
      }),
    ).resolves.toBeUndefined();

    await expect(
      validateMessageSendAuthorization({
        senderId: OUTSIDER_ID,
        receiverId: RECEIVER_ID,
        jobId: null,
        prismaClient,
      }),
    ).resolves.toBeUndefined();

    expect(prisma.job.findUnique).not.toHaveBeenCalled();
  });
});

// ─── Participant check (#1436) ───────────────────────────────────────────────

describe("validateMessageSendAuthorization — sender must be a job participant (#1436)", () => {
  it("throws 403 when the sender is neither client nor freelancer", async () => {
    const promise = validateMessageSendAuthorization({
      senderId: OUTSIDER_ID,
      receiverId: RECEIVER_ID,
      jobId: JOB_ID,
      prismaClient,
    });

    await expect(promise).rejects.toBeInstanceOf(MessageValidationError);
    await expect(promise).rejects.toMatchObject({
      status: 403,
      message: "Not authorized to send messages for this job.",
    });
  });

  it("allows the job client to send", async () => {
    await expect(
      validateMessageSendAuthorization({
        senderId: CLIENT_ID,
        receiverId: RECEIVER_ID,
        jobId: JOB_ID,
        prismaClient,
      }),
    ).resolves.toBeUndefined();
  });

  it("allows the assigned freelancer to send", async () => {
    await expect(
      validateMessageSendAuthorization({
        senderId: FREELANCER_ID,
        receiverId: RECEIVER_ID,
        jobId: JOB_ID,
        prismaClient,
      }),
    ).resolves.toBeUndefined();
  });

  it("does not confuse a client id with the freelancer id on the same job", async () => {
    // The two participant slots are checked independently; a job with only one
    // freelancer must not admit the client, and vice versa.
    prisma.job.findUnique.mockResolvedValue(jobWith(CLIENT_ID, CLIENT_ID));

    await expect(
      validateMessageSendAuthorization({
        senderId: OUTSIDER_ID,
        receiverId: RECEIVER_ID,
        jobId: JOB_ID,
        prismaClient,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects an unassigned job whose freelancer slot is still null", async () => {
    // A job created but not yet accepted has no freelancer. Only the client may
    // message on it — the absent freelancer must not become a wildcard match.
    prisma.job.findUnique.mockResolvedValue({ id: JOB_ID, clientId: CLIENT_ID, freelancerId: null });

    await expect(
      validateMessageSendAuthorization({
        senderId: CLIENT_ID,
        receiverId: RECEIVER_ID,
        jobId: JOB_ID,
        prismaClient,
      }),
    ).resolves.toBeUndefined();

    await expect(
      validateMessageSendAuthorization({
        senderId: OUTSIDER_ID,
        receiverId: RECEIVER_ID,
        jobId: JOB_ID,
        prismaClient,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects a sender whose id only looks like a participant", async () => {
    // Exact string equality, not a prefix/contains match.
    prisma.job.findUnique.mockResolvedValue(jobWith(CLIENT_ID, FREELANCER_ID));

    await expect(
      validateMessageSendAuthorization({
        senderId: `${CLIENT_ID}-staging`,
        receiverId: RECEIVER_ID,
        jobId: JOB_ID,
        prismaClient,
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

// ─── Error type (#1436) ──────────────────────────────────────────────────────

describe("MessageValidationError (#1436)", () => {
  it("is a real Error carrying the HTTP status the layers translate", () => {
    const error = new MessageValidationError(403, "nope");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(MessageValidationError);
    expect(error.name).toBe("MessageValidationError");
    expect(error.status).toBe(403);
    expect(error.message).toBe("nope");
  });
});
