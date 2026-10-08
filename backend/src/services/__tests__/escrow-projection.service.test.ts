interface MockEscrowEventModel {
  findMany: jest.Mock;
}

interface MockPrismaClient {
  escrowEvent: MockEscrowEventModel;
}

jest.mock("@prisma/client", () => {
  const original = jest.requireActual("@prisma/client");
  const mockPrisma: MockPrismaClient = {
    escrowEvent: {
      findMany: jest.fn(),
    },
  };
  return {
    ...original,
    PrismaClient: jest.fn(() => mockPrisma),
  };
});

import { PrismaClient, Prisma } from "@prisma/client";
import { applyEvent, initialState, projectJobState } from "../escrow-projection.service";
import { EscrowEvent, EscrowEventType, JobStatus, EscrowStatus } from "@prisma/client";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;

function createMockEvent(
  eventType: EscrowEventType,
  ledgerSeq: number,
  payload: Prisma.JsonValue = {}
): EscrowEvent {
  return {
    id: `event-${ledgerSeq}`,
    jobId: "job-123",
    contractJobId: "contract-123",
    eventType,
    ledgerSeq,
    txHash: `tx-${ledgerSeq}`,
    payload,
    processedAt: new Date(),
  };
}

describe("Escrow State Projection Service", () => {
  beforeEach(() => {
    prismaMock.escrowEvent.findMany.mockReset();
  });

  describe("applyEvent", () => {
    it("should start with open and unfunded status", () => {
      expect(initialState).toEqual({
        status: "OPEN",
        escrowStatus: "UNFUNDED",
      });
    });

    it("should process JOB_CREATED", () => {
      const event = createMockEvent(EscrowEventType.JOB_CREATED, 1);
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "OPEN",
        escrowStatus: "UNFUNDED",
      });
    });

    it("should process JOB_FUNDED", () => {
      const event = createMockEvent(EscrowEventType.JOB_FUNDED, 2);
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "IN_PROGRESS",
        escrowStatus: "FUNDED",
      });
    });

    it("should process PAYMENT_RELEASED", () => {
      const event = createMockEvent(EscrowEventType.PAYMENT_RELEASED, 3);
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "COMPLETED",
        escrowStatus: "COMPLETED",
      });
    });

    it("should process DISPUTE_OPENED", () => {
      const event = createMockEvent(EscrowEventType.DISPUTE_OPENED, 3);
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "DISPUTED",
        escrowStatus: "DISPUTED",
      });
    });

    it("should process DISPUTE_RESOLVED for Client", () => {
      const event = createMockEvent(EscrowEventType.DISPUTE_RESOLVED, 4, {
        rawStatus: "ResolvedForClient",
      });
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "CANCELLED",
        escrowStatus: "CANCELLED",
      });
    });

    it("should process DISPUTE_RESOLVED for Freelancer", () => {
      const event = createMockEvent(EscrowEventType.DISPUTE_RESOLVED, 4, {
        rawStatus: "ResolvedForFreelancer",
      });
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "COMPLETED",
        escrowStatus: "COMPLETED",
      });
    });

    it("should process DISPUTE_RESOLVED for RefundedBoth", () => {
      const event = createMockEvent(EscrowEventType.DISPUTE_RESOLVED, 4, {
        rawStatus: "RefundedBoth",
      });
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "CANCELLED",
        escrowStatus: "CANCELLED",
      });
    });

    it("should process DISPUTE_RESOLVED for Escalated (keeps disputed status)", () => {
      const startState = { status: JobStatus.DISPUTED, escrowStatus: EscrowStatus.DISPUTED };
      const event = createMockEvent(EscrowEventType.DISPUTE_RESOLVED, 4, {
        rawStatus: "Escalated",
      });
      const state = applyEvent(startState, event);
      expect(state).toEqual(startState);
    });

    it("should process REFUNDED", () => {
      const event = createMockEvent(EscrowEventType.REFUNDED, 3);
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "CANCELLED",
        escrowStatus: "CANCELLED",
      });
    });

    it("should process EXPIRED", () => {
      const event = createMockEvent(EscrowEventType.EXPIRED, 3);
      const state = applyEvent(initialState, event);
      expect(state).toEqual({
        status: "EXPIRED",
        escrowStatus: "CANCELLED",
      });
    });
  });

  describe("projectJobState", () => {
    it("should query events sorted by ledger sequence and project state", async () => {
      const event1 = createMockEvent(EscrowEventType.JOB_CREATED, 10);
      const event2 = createMockEvent(EscrowEventType.JOB_FUNDED, 20);
      const event3 = createMockEvent(EscrowEventType.PAYMENT_RELEASED, 30);

      // Return events sorted, as the database would do given the orderBy clause
      prismaMock.escrowEvent.findMany.mockResolvedValueOnce([event1, event2, event3]);

      const state = await projectJobState("job-123");

      expect(prismaMock.escrowEvent.findMany).toHaveBeenCalledWith({
        where: { jobId: "job-123" },
        orderBy: { ledgerSeq: "asc" },
      });

      // Events applied in order: 10 -> 20 -> 30, resulting in COMPLETED
      expect(state).toEqual({
        status: "COMPLETED",
        escrowStatus: "COMPLETED",
      });
    });
  });
});
