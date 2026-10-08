jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../lib/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

interface MockEscrowEventRecord {
  id: string;
  jobId: string;
  contractJobId: string;
  eventType: string;
  ledgerSeq: number;
  txHash: string;
  payload: unknown;
  processedAt: Date;
}

interface MockJobState {
  id: string;
  contractJobId: string;
  status: string;
  escrowStatus: string;
  title: string;
  clientId: string;
  freelancerId: string;
}

declare global {
  // eslint-disable-next-line no-var -- `declare global` requires `var` for ambient globals
  var mockEventsDb: MockEscrowEventRecord[];
  // eslint-disable-next-line no-var -- `declare global` requires `var` for ambient globals
  var mockJobState: MockJobState;
}

jest.mock("@prisma/client", () => {
  const original = jest.requireActual("@prisma/client");

  const mockPrisma = {
    escrowEvent: {
      create: jest.fn().mockImplementation((args) => {
        const { jobId, contractJobId, eventType, ledgerSeq, txHash, payload } = args.data;

        const duplicate = global.mockEventsDb.find(
          (e) =>
            e.contractJobId === contractJobId &&
            e.eventType === eventType &&
            e.ledgerSeq === ledgerSeq
        );

        if (duplicate) {
          const error = new Error("Unique constraint failed") as Error & { code?: string };
          error.code = "P2002";
          throw error;
        }

        const record: MockEscrowEventRecord = {
          id: `event-${Date.now()}-${Math.random()}`,
          jobId,
          contractJobId,
          eventType,
          ledgerSeq,
          txHash,
          payload,
          processedAt: new Date(),
        };
        global.mockEventsDb.push(record);
        return record;
      }),
      findMany: jest.fn().mockImplementation((args) => {
        if (args.where.jobId === "job-abc") {
          return [...global.mockEventsDb].sort((a, b) => a.ledgerSeq - b.ledgerSeq);
        }
        return [];
      }),
    },
    job: {
      findUnique: jest.fn().mockImplementation((args) => {
        if (args.where.id === "job-abc") {
          return global.mockJobState;
        }
        return null;
      }),
      update: jest.fn().mockImplementation((args) => {
        if (args.where.id === "job-abc") {
          global.mockJobState = {
            ...global.mockJobState,
            ...args.data,
          };
          return global.mockJobState;
        }
        return null;
      }),
    },
    dispute: {
      upsert: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
  };

  return {
    ...original,
    PrismaClient: jest.fn(() => mockPrisma),
  };
});

// Setup mockEventsDb and mockJobState in global scope before anything else
global.mockEventsDb = [];
global.mockJobState = {
  id: "job-abc",
  contractJobId: "contract-abc",
  status: "OPEN",
  escrowStatus: "UNFUNDED",
  title: "Test Integration Job",
  clientId: "client-1",
  freelancerId: "freelancer-1",
};

import { handleEscrowEvent } from "../services/escrow-projection.service";
import { NotificationService } from "../services/notification.service";
import { EscrowEventType, JobStatus, EscrowStatus } from "@prisma/client";

describe("Escrow State Event Sourcing Integration Tests", () => {
  beforeEach(() => {
    global.mockEventsDb = [];
    global.mockJobState = {
      id: "job-abc",
      contractJobId: "contract-abc",
      status: JobStatus.OPEN,
      escrowStatus: EscrowStatus.UNFUNDED,
      title: "Test Integration Job",
      clientId: "client-1",
      freelancerId: "freelancer-1",
    };
    jest.clearAllMocks();
  });

  it("should process unique events and send notifications only on state changes", async () => {
    // 1. Process JOB_CREATED
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.JOB_CREATED,
      ledgerSeq: 1,
      txHash: "tx-1",
      payload: {},
    });

    // JOB_CREATED should set UNFUNDED (already default status), so no state change notification
    expect(NotificationService.sendNotification).not.toHaveBeenCalled();
    expect(global.mockJobState.escrowStatus).toBe(EscrowStatus.UNFUNDED);

    // 2. Process JOB_FUNDED
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.JOB_FUNDED,
      ledgerSeq: 2,
      txHash: "tx-2",
      payload: {},
    });

    expect(global.mockJobState.status).toBe(JobStatus.IN_PROGRESS);
    expect(global.mockJobState.escrowStatus).toBe(EscrowStatus.FUNDED);

    // 3. Process PAYMENT_RELEASED (should trigger PAYMENT_RELEASED notification)
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.PAYMENT_RELEASED,
      ledgerSeq: 3,
      txHash: "tx-3",
      payload: { amount: "1000" },
    });

    expect(global.mockJobState.status).toBe(JobStatus.COMPLETED);
    expect(global.mockJobState.escrowStatus).toBe(EscrowStatus.COMPLETED);
    expect(NotificationService.sendNotification).toHaveBeenCalledTimes(2); // Sent to client & freelancer
  });

  it("should ignore duplicate events and suppress duplicate notifications", async () => {
    // 1. Send JOB_FUNDED first
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.JOB_FUNDED,
      ledgerSeq: 1,
      txHash: "tx-funded",
      payload: {},
    });

    // 2. Send PAYMENT_RELEASED once
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.PAYMENT_RELEASED,
      ledgerSeq: 2,
      txHash: "tx-pmt-1",
      payload: { amount: "100" },
    });

    const callsCountBeforeDuplicate = (NotificationService.sendNotification as jest.Mock).mock.calls.length;
    expect(callsCountBeforeDuplicate).toBe(2); // Sent to both client and freelancer once

    // 3. Send duplicate PAYMENT_RELEASED (should hit P2002 and exit early)
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.PAYMENT_RELEASED,
      ledgerSeq: 2,
      txHash: "tx-pmt-2", // different txHash but same contractJobId, eventType, ledgerSeq
      payload: { amount: "100" },
    });

    // Notifications shouldn't have increased
    const callsCountAfterDuplicate = (NotificationService.sendNotification as jest.Mock).mock.calls.length;
    expect(callsCountAfterDuplicate).toBe(callsCountBeforeDuplicate);
    expect(global.mockEventsDb.length).toBe(2); // only unique events stored
  });

  it("should produce correct final state (COMPLETED) when events arrive out-of-order", async () => {
    // Send PAYMENT_RELEASED (ledgerSeq 3) first (out-of-order)
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.PAYMENT_RELEASED,
      ledgerSeq: 3,
      txHash: "tx-pmt",
      payload: { amount: "500" },
    });

    // Because only PAYMENT_RELEASED (ledgerSeq 3) is in log, it reduces to COMPLETED
    expect(global.mockJobState.status).toBe(JobStatus.COMPLETED);

    // Send JOB_FUNDED (ledgerSeq 2) second (out-of-order arrival)
    await handleEscrowEvent({
      jobId: "job-abc",
      contractJobId: "contract-abc",
      eventType: EscrowEventType.JOB_FUNDED,
      ledgerSeq: 2,
      txHash: "tx-funded",
      payload: {},
    });

    // The projection sorts [JOB_FUNDED (2), PAYMENT_RELEASED (3)]
    // Reducing sequence: JOB_CREATED (implicit) -> JOB_FUNDED -> PAYMENT_RELEASED
    // Final state should still be COMPLETED
    expect(global.mockJobState.status).toBe(JobStatus.COMPLETED);
    expect(global.mockJobState.escrowStatus).toBe(EscrowStatus.COMPLETED);
  });
});
