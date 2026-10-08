import { recordDisputeEvent } from "../dispute-event.service";
import { disputeEmitter } from "../../lib/dispute-emitter";

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    disputeEvent: {
      create: jest.fn(),
    },
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma),
    DisputeEventType: {
      DISPUTE_OPENED: "DISPUTE_OPENED",
      EVIDENCE_SUBMITTED: "EVIDENCE_SUBMITTED",
      ARBITRATOR_ASSIGNED: "ARBITRATOR_ASSIGNED",
      VOTE_CAST: "VOTE_CAST",
      VERDICT_REACHED: "VERDICT_REACHED",
    },
  };
});

import { PrismaClient } from "@prisma/client";

const prismaMock = new PrismaClient() as unknown as {
  disputeEvent: { create: jest.Mock };
};

describe("recordDisputeEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("persists and emits a dispute event", async () => {
    const createdEvent = {
      id: 7,
      disputeId: "dispute-1",
      type: "VOTE_CAST",
      payload: { voteCount: 2 },
      createdAt: new Date("2026-06-17T15:45:00Z"),
    };

    prismaMock.disputeEvent.create.mockResolvedValueOnce(createdEvent);
    const emitSpy = jest.spyOn(disputeEmitter, "emitDisputeEvent");

    const result = await recordDisputeEvent("dispute-1", "VOTE_CAST", {
      voteCount: 2,
    });

    expect(prismaMock.disputeEvent.create).toHaveBeenCalledWith({
      data: {
        disputeId: "dispute-1",
        type: "VOTE_CAST",
        payload: { voteCount: 2 },
      },
    });
    expect(emitSpy).toHaveBeenCalledWith("dispute-1", createdEvent);
    expect(result).toEqual(createdEvent);
  });
});
