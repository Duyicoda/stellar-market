import { NotificationService } from "../notification.service";
import { NotificationType } from "@prisma/client";

// Mock Prisma and Socket.IO
jest.mock("@prisma/client", () => ({
  PrismaClient: jest.fn().mockImplementation(() => ({
    notification: {
      create: jest.fn().mockResolvedValue({
        id: "test-id",
        userId: "user1",
        type: "MILESTONE_APPROVED",
        title: "Test",
        message: "Test message",
        metadata: {},
        createdAt: new Date(),
        read: false,
      }),
    },
  })),
  NotificationType: {
    MILESTONE_APPROVED: "MILESTONE_APPROVED",
    MILESTONE_SUBMITTED: "MILESTONE_SUBMITTED",
    APPLICATION_REJECTED: "APPLICATION_REJECTED",
    DISPUTE_RAISED: "DISPUTE_RAISED",
  },
}));

jest.mock("../../socket", () => ({
  getIo: jest.fn().mockReturnValue({
    to: jest.fn().mockReturnValue({
      emit: jest.fn(),
    }),
  }),
}));

interface BatchedNotificationInput {
  title: string;
  message: string;
  metadata: Record<string, unknown>;
  timestamp: number;
}

interface NotificationServiceInternals {
  batches: Map<string, { notifications: unknown[] }>;
  MAX_BATCH_SIZE: number;
  clearAllBatches: () => void;
  createBatchedNotification: (
    type: string,
    notifications: BatchedNotificationInput[],
  ) => { title: string; message: string; metadata: { type: string } };
}

const NotificationServiceInternal =
  NotificationService as unknown as NotificationServiceInternals;

describe.skip("NotificationService Batching", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Clear any existing batches
    NotificationServiceInternal.batches.clear();
  });

  afterEach(async () => {
    // Clean up any pending batches
    await NotificationService.flushAllBatches();
    NotificationServiceInternal.clearAllBatches();
  });

  it("should batch multiple similar notifications", async () => {
    const userId = "user1";
    const type = NotificationType.MILESTONE_APPROVED;

    // Send multiple notifications quickly
    await Promise.all([
      NotificationService.sendNotification({
        userId,
        type,
        title: "Milestone 1 Approved",
        message: "Your milestone 1 has been approved",
      }),
      NotificationService.sendNotification({
        userId,
        type,
        title: "Milestone 2 Approved",
        message: "Your milestone 2 has been approved",
      }),
      NotificationService.sendNotification({
        userId,
        type,
        title: "Milestone 3 Approved",
        message: "Your milestone 3 has been approved",
      }),
    ]);

    // Check that batches are created
    const batches = NotificationServiceInternal.batches;
    const batchKey = `${userId}:${type}`;
    expect(batches.has(batchKey)).toBe(true);
    expect(batches.get(batchKey)!.notifications).toHaveLength(3);

    // Flush batches and verify combined notification
    await NotificationService.flushAllBatches();
    expect(batches.size).toBe(0);
  });

  it("should not batch urgent notifications", async () => {
    const userId = "user1";
    const type = NotificationType.DISPUTE_RAISED;

    // Send urgent notification
    const result = await NotificationService.sendNotification({
      userId,
      type,
      title: "Dispute Raised",
      message: "A dispute has been raised",
    });

    // Should be sent immediately, not batched
    expect(result).toBeTruthy();

    const batches = NotificationServiceInternal.batches;
    expect(batches.size).toBe(0);
  });

  it("should skip batching when explicitly requested", async () => {
    const userId = "user1";
    const type = NotificationType.MILESTONE_APPROVED;

    // Send notification with skipBatching flag
    const result = await NotificationService.sendNotification({
      userId,
      type,
      title: "Urgent Milestone Approved",
      message: "Your milestone has been approved urgently",
      skipBatching: true,
    });

    // Should be sent immediately
    expect(result).toBeTruthy();

    const batches = NotificationServiceInternal.batches;
    expect(batches.size).toBe(0);
  });

  it("should flush batch when max size is reached", async () => {
    const userId = "user1";
    const type = NotificationType.APPLICATION_REJECTED;
    const maxBatchSize = NotificationServiceInternal.MAX_BATCH_SIZE;

    // Send more notifications than max batch size
    const promises = [];
    for (let i = 0; i < maxBatchSize + 1; i++) {
      promises.push(
        NotificationService.sendNotification({
          userId,
          type,
          title: `Application ${i} Rejected`,
          message: `Your application ${i} has been rejected`,
        }),
      );
    }

    await Promise.all(promises);

    // Batch should have been flushed automatically
    const batches = NotificationServiceInternal.batches;
    const batchKey = `${userId}:${type}`;

    // Should either be empty (flushed) or have only 1 notification (the overflow)
    if (batches.has(batchKey)) {
      expect(batches.get(batchKey)!.notifications.length).toBeLessThanOrEqual(1);
    }
  });

  it("should create appropriate batched messages for different notification types", () => {
    const createBatchedNotification =
      NotificationServiceInternal.createBatchedNotification;

    const milestoneNotifications = [
      {
        title: "Milestone 1",
        message: "Test 1",
        metadata: {},
        timestamp: Date.now(),
      },
      {
        title: "Milestone 2",
        message: "Test 2",
        metadata: {},
        timestamp: Date.now(),
      },
      {
        title: "Milestone 3",
        message: "Test 3",
        metadata: {},
        timestamp: Date.now(),
      },
    ];

    const result = createBatchedNotification(
      "MILESTONE_APPROVED",
      milestoneNotifications,
    );

    expect(result.title).toBe("3 Milestones Approved");
    expect(result.message).toBe(
      "3 of your milestones have been approved by the client.",
    );
    expect(result.metadata.type).toBe("batch_milestone_approved");
  });
});
