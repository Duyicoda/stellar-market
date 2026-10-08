/**
 * Issue #1182: notifications for job removal and expiry were silently dropped
 * because the call sites passed a value that is not a NotificationType member.
 *
 * This suite drives the real NotificationService against a Prisma mock that
 * enforces enum membership the way the database does, proving that the types
 * now used by those call sites are persisted rather than rejected.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockNotificationCreate = jest.fn<(args: { data: { type: string } }) => Promise<unknown>>();

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client") as {
    NotificationType: Record<string, string>;
  };
  const validTypes = Object.values(actual.NotificationType);
  const tx = {
    notification: {
      create: (args: { data: { type: string } }) => {
        if (!validTypes.includes(args.data.type)) {
          return Promise.reject(
            new Error(`Invalid value for argument \`type\`. Expected NotificationType, got ${args.data.type}`),
          );
        }
        return mockNotificationCreate(args);
      },
    },
  };
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      notification: tx.notification,
    })),
    Prisma: {},
    NotificationType: actual.NotificationType,
  };
});

const mockQueueAdd = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../lib/notification-queue", () => ({
  notificationQueue: { add: mockQueueAdd },
  getNotificationPriority: jest.fn().mockReturnValue(2),
}));
jest.mock("../socket", () => ({ getIo: jest.fn() }));
jest.mock("./../services/email.service", () => ({ EmailService: {} }));
jest.mock("web-push", () => ({ __esModule: true, default: {}, WebPushError: class {} }));
jest.mock("../config", () => ({ config: { frontendUrl: "http://localhost:3000" } }));
const mockLoggerError = jest.fn();
jest.mock("../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: mockLoggerError, debug: jest.fn() },
}));

import { NotificationType } from "@prisma/client";
import { NotificationService } from "../services/notification.service";

describe("NotificationService with enum-enforcing persistence", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockQueueAdd.mockResolvedValue(undefined);
    mockNotificationCreate.mockImplementation(async ({ data }) => ({ id: "notif-1", ...data }));
  });

  it("persists a JOB_REMOVED notification (moderator removal)", async () => {
    const result = await NotificationService.sendNotification({
      userId: "client-1",
      type: NotificationType.JOB_REMOVED,
      title: "Job Removed by Moderator",
      message: "removed",
      skipBatching: true,
    });

    expect(result).toMatchObject({ id: "notif-1", type: "JOB_REMOVED" });
    expect(mockNotificationCreate).toHaveBeenCalledTimes(1);
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("persists a JOB_EXPIRED notification (expiry job)", async () => {
    const result = await NotificationService.sendNotification({
      userId: "client-1",
      type: NotificationType.JOB_EXPIRED,
      title: "Job Expired",
      message: "expired",
      skipBatching: true,
    });

    expect(result).toMatchObject({ id: "notif-1", type: "JOB_EXPIRED" });
    expect(mockLoggerError).not.toHaveBeenCalled();
  });

  it("persists batched job notifications once the batch window flushes", async () => {
    jest.useFakeTimers();
    try {
      const pending = NotificationService.sendNotification({
        userId: "client-2",
        type: NotificationType.JOB_EXPIRED,
        title: "Job Expired",
        message: "expired",
      });
      await expect(pending).resolves.toBeNull();
      expect(mockNotificationCreate).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(5000);

      expect(mockNotificationCreate).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ type: "JOB_EXPIRED" }) }),
      );
      expect(mockLoggerError).not.toHaveBeenCalled();
    } finally {
      NotificationService.clearAllBatches();
      jest.useRealTimers();
    }
  });

  it("shows why the old value failed: a non-member type is rejected and swallowed", async () => {
    const result = await NotificationService.sendNotification({
      userId: "client-1",
      type: "CANCELLED" as unknown as NotificationType,
      title: "Job Removed",
      message: "removed",
      skipBatching: true,
    });

    expect(result).toBeNull();
    expect(mockNotificationCreate).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Error sending notification",
    );
  });

  it("exposes JOB_REMOVED and JOB_EXPIRED on the generated enum", () => {
    expect(NotificationType.JOB_REMOVED).toBe("JOB_REMOVED");
    expect(NotificationType.JOB_EXPIRED).toBe("JOB_EXPIRED");
    expect(Object.values(NotificationType)).not.toContain("CANCELLED");
  });
});
