import { DeadlineExtensionService } from "../deadline-extension.service";
import { ContractService } from "../contract.service";

jest.mock("../contract.service", () => ({
  ContractService: {
    buildExtendDeadlineTx: jest.fn(),
  },
}));

jest.mock("../notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn().mockResolvedValue({ id: "mock-notif-id" }),
  },
}));

const DeadlineExtensionStatus = {
  PENDING: "PENDING",
  APPROVED_BY_CLIENT: "APPROVED_BY_CLIENT",
  APPROVED_BY_FREELANCER: "APPROVED_BY_FREELANCER",
  APPROVED_BY_BOTH: "APPROVED_BY_BOTH",
  REJECTED: "REJECTED",
  EXPIRED: "EXPIRED",
} as const;

interface MockMilestoneModel {
  findUnique: jest.Mock;
  update: jest.Mock;
}

interface MockDeadlineExtensionRequestModel {
  create: jest.Mock;
  findFirst: jest.Mock;
  findUnique: jest.Mock;
  findMany: jest.Mock;
  update: jest.Mock;
}

interface MockPrismaClient {
  milestone: MockMilestoneModel;
  deadlineExtensionRequest: MockDeadlineExtensionRequestModel;
}

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    milestone: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    deadlineExtensionRequest: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
    },
  };

  return {
    PrismaClient: jest.fn(() => mockPrisma),
    DeadlineExtensionStatus: {
      PENDING: "PENDING",
      APPROVED_BY_CLIENT: "APPROVED_BY_CLIENT",
      APPROVED_BY_FREELANCER: "APPROVED_BY_FREELANCER",
      APPROVED_BY_BOTH: "APPROVED_BY_BOTH",
      REJECTED: "REJECTED",
      EXPIRED: "EXPIRED",
    },
    JobStatus: {
      OPEN: "OPEN",
      IN_PROGRESS: "IN_PROGRESS",
      COMPLETED: "COMPLETED",
    },
  };
});

import { PrismaClient } from "@prisma/client";
import { NotificationService } from "../notification.service";
const prismaMock = new PrismaClient() as unknown as MockPrismaClient;

// ─── Test data ────────────────────────────────────────────────────────────────
const clientId = "00000000-0000-4000-8000-000000000001";
const freelancerId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-000000000100";
const milestoneId = "00000000-0000-4000-8000-000000000200";
const extensionRequestId = "00000000-0000-4000-8000-000000000300";
const futureDeadline = new Date(Date.now() + 7 * 86400000);

const mockJob = {
  id: jobId,
  clientId,
  freelancerId,
  contractJobId: "contract-1",
  client: { id: clientId, walletAddress: "GCLIENT123" },
  freelancer: { id: freelancerId, walletAddress: "GFREELANCER123" },
};

const mockMilestone = {
  id: milestoneId,
  jobId,
  title: "Design mockups",
  onChainIndex: 0,
  job: mockJob,
};

const mockExtensionRequest = {
  id: extensionRequestId,
  milestoneId,
  jobId,
  requestedById: clientId,
  newDeadline: futureDeadline,
  reason: "Need more time to finish the deliverables properly",
  status: DeadlineExtensionStatus.PENDING,
  clientApprovedAt: null,
  freelancerApprovedAt: null,
  rejectedBy: null,
  rejectionReason: null,
  onChainTxHash: null,
  milestone: mockMilestone,
  job: mockJob,
  requestedBy: { id: clientId, username: "client" },
};

afterEach(() => jest.resetAllMocks());

describe("DeadlineExtensionService", () => {
  describe("requestExtension", () => {
    it("creates a request and notifies the other party", async () => {
      prismaMock.milestone.findUnique.mockResolvedValueOnce(mockMilestone);
      prismaMock.deadlineExtensionRequest.findFirst.mockResolvedValueOnce(null);
      prismaMock.deadlineExtensionRequest.create.mockResolvedValueOnce(
        mockExtensionRequest,
      );

      const result = await DeadlineExtensionService.requestExtension(
        milestoneId,
        jobId,
        clientId,
        futureDeadline,
        "Need more time to finish the deliverables properly",
      );

      expect(result).toEqual(mockExtensionRequest);
      expect(NotificationService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: freelancerId, skipBatching: true }),
      );
    });

    it("rejects a request for a milestone that does not belong to the job", async () => {
      prismaMock.milestone.findUnique.mockResolvedValueOnce({
        ...mockMilestone,
        jobId: "different-job",
      });

      await expect(
        DeadlineExtensionService.requestExtension(
          milestoneId,
          jobId,
          clientId,
          futureDeadline,
          "Need more time to finish the deliverables properly",
        ),
      ).rejects.toThrow("Milestone does not belong to this job");
    });

    it("rejects a request from a non-participant", async () => {
      prismaMock.milestone.findUnique.mockResolvedValueOnce(mockMilestone);

      await expect(
        DeadlineExtensionService.requestExtension(
          milestoneId,
          jobId,
          "00000000-0000-4000-8000-000000009999",
          futureDeadline,
          "Need more time to finish the deliverables properly",
        ),
      ).rejects.toThrow("Only job participants can request deadline extensions");
    });

    it("rejects a new deadline that is not in the future", async () => {
      prismaMock.milestone.findUnique.mockResolvedValueOnce(mockMilestone);

      await expect(
        DeadlineExtensionService.requestExtension(
          milestoneId,
          jobId,
          clientId,
          new Date(Date.now() - 1000),
          "Need more time to finish the deliverables properly",
        ),
      ).rejects.toThrow("New deadline must be in the future");
    });

    it("rejects when a pending extension request already exists", async () => {
      prismaMock.milestone.findUnique.mockResolvedValueOnce(mockMilestone);
      prismaMock.deadlineExtensionRequest.findFirst.mockResolvedValueOnce(
        mockExtensionRequest,
      );

      await expect(
        DeadlineExtensionService.requestExtension(
          milestoneId,
          jobId,
          clientId,
          futureDeadline,
          "Need more time to finish the deliverables properly",
        ),
      ).rejects.toThrow(
        "A pending extension request already exists for this milestone",
      );
    });
  });

  describe("approveExtension", () => {
    it("rejects self-approval by the original requester", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
        mockExtensionRequest,
      );

      await expect(
        DeadlineExtensionService.approveExtension(extensionRequestId, clientId),
      ).rejects.toThrow("You cannot approve your own extension request");
      expect(prismaMock.deadlineExtensionRequest.update).not.toHaveBeenCalled();
    });

    it("records client approval when freelancer requested (order: freelancer requests, client approves)", async () => {
      const request = { ...mockExtensionRequest, requestedById: freelancerId };
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(request);
      prismaMock.deadlineExtensionRequest.update.mockResolvedValueOnce({
        ...request,
        status: DeadlineExtensionStatus.APPROVED_BY_CLIENT,
        clientApprovedAt: new Date(),
      });

      const result = await DeadlineExtensionService.approveExtension(
        extensionRequestId,
        clientId,
      );

      expect(result.status).toBe(DeadlineExtensionStatus.APPROVED_BY_CLIENT);
      expect(prismaMock.deadlineExtensionRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: extensionRequestId },
          data: expect.objectContaining({
            status: DeadlineExtensionStatus.APPROVED_BY_CLIENT,
          }),
        }),
      );
      expect(ContractService.buildExtendDeadlineTx).not.toHaveBeenCalled();
    });

    it("records freelancer approval when client requested (order: client requests, freelancer approves)", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
        mockExtensionRequest,
      );
      prismaMock.deadlineExtensionRequest.update.mockResolvedValueOnce({
        ...mockExtensionRequest,
        status: DeadlineExtensionStatus.APPROVED_BY_FREELANCER,
        freelancerApprovedAt: new Date(),
      });

      const result = await DeadlineExtensionService.approveExtension(
        extensionRequestId,
        freelancerId,
      );

      expect(result.status).toBe(DeadlineExtensionStatus.APPROVED_BY_FREELANCER);
      expect(ContractService.buildExtendDeadlineTx).not.toHaveBeenCalled();
    });

    it("triggers on-chain execution once both parties have approved (client already approved, freelancer approves)", async () => {
      const partiallyApproved = {
        ...mockExtensionRequest,
        clientApprovedAt: new Date(),
      };
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
        partiallyApproved,
      );
      const fullyApproved = {
        ...partiallyApproved,
        status: DeadlineExtensionStatus.APPROVED_BY_BOTH,
        freelancerApprovedAt: new Date(),
      };
      prismaMock.deadlineExtensionRequest.update
        .mockResolvedValueOnce(fullyApproved) // status update
        .mockResolvedValueOnce(fullyApproved); // executeExtensionOnChain's internal update
      (ContractService.buildExtendDeadlineTx as jest.Mock).mockResolvedValueOnce(
        "EXTEND_XDR",
      );

      const result = await DeadlineExtensionService.approveExtension(
        extensionRequestId,
        freelancerId,
      );

      expect(result.status).toBe(DeadlineExtensionStatus.APPROVED_BY_BOTH);
      expect(ContractService.buildExtendDeadlineTx).toHaveBeenCalledWith(
        mockJob.client.walletAddress,
        mockJob.contractJobId,
        mockMilestone.onChainIndex,
        Math.floor(fullyApproved.newDeadline.getTime() / 1000),
      );
    });

    it("triggers on-chain execution once both parties have approved (freelancer already approved, client approves)", async () => {
      const partiallyApproved = {
        ...mockExtensionRequest,
        requestedById: freelancerId,
        freelancerApprovedAt: new Date(),
      };
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
        partiallyApproved,
      );
      const fullyApproved = {
        ...partiallyApproved,
        status: DeadlineExtensionStatus.APPROVED_BY_BOTH,
        clientApprovedAt: new Date(),
      };
      prismaMock.deadlineExtensionRequest.update
        .mockResolvedValueOnce(fullyApproved)
        .mockResolvedValueOnce(fullyApproved);
      (ContractService.buildExtendDeadlineTx as jest.Mock).mockResolvedValueOnce(
        "EXTEND_XDR",
      );

      const result = await DeadlineExtensionService.approveExtension(
        extensionRequestId,
        clientId,
      );

      expect(result.status).toBe(DeadlineExtensionStatus.APPROVED_BY_BOTH);
      expect(ContractService.buildExtendDeadlineTx).toHaveBeenCalledTimes(1);
    });

    it("rejects approving a request that is not pending", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce({
        ...mockExtensionRequest,
        status: DeadlineExtensionStatus.REJECTED,
      });

      await expect(
        DeadlineExtensionService.approveExtension(extensionRequestId, freelancerId),
      ).rejects.toThrow(
        "Cannot approve extension request with status: REJECTED",
      );
    });

    it("rejects approval from a non-participant", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
        mockExtensionRequest,
      );

      await expect(
        DeadlineExtensionService.approveExtension(
          extensionRequestId,
          "00000000-0000-4000-8000-000000009999",
        ),
      ).rejects.toThrow("Only job participants can approve extension requests");
    });
  });

  describe("rejectExtension", () => {
    it("rejects a pending request and notifies the requester", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
        mockExtensionRequest,
      );
      prismaMock.deadlineExtensionRequest.update.mockResolvedValueOnce({
        ...mockExtensionRequest,
        status: DeadlineExtensionStatus.REJECTED,
        rejectedBy: freelancerId,
        rejectionReason: "Too long",
      });

      const result = await DeadlineExtensionService.rejectExtension(
        extensionRequestId,
        freelancerId,
        "Too long",
      );

      expect(result.status).toBe(DeadlineExtensionStatus.REJECTED);
      expect(NotificationService.sendNotification).toHaveBeenCalledWith(
        expect.objectContaining({ userId: mockExtensionRequest.requestedById }),
      );
    });

    it("rejects rejecting a request that is not pending", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce({
        ...mockExtensionRequest,
        status: DeadlineExtensionStatus.APPROVED_BY_BOTH,
      });

      await expect(
        DeadlineExtensionService.rejectExtension(
          extensionRequestId,
          freelancerId,
          "Too long",
        ),
      ).rejects.toThrow(
        "Cannot reject extension request with status: APPROVED_BY_BOTH",
      );
    });

    it("rejects rejection from a non-participant", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(
        mockExtensionRequest,
      );

      await expect(
        DeadlineExtensionService.rejectExtension(
          extensionRequestId,
          "00000000-0000-4000-8000-000000009999",
          "Too long",
        ),
      ).rejects.toThrow("Only job participants can reject extension requests");
    });

    it("throws when the extension request does not exist", async () => {
      prismaMock.deadlineExtensionRequest.findUnique.mockResolvedValueOnce(null);

      await expect(
        DeadlineExtensionService.rejectExtension(
          extensionRequestId,
          freelancerId,
          "Too long",
        ),
      ).rejects.toThrow("Extension request not found");
    });
  });
});
