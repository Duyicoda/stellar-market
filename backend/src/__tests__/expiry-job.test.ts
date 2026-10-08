/**
 * Tests for the job expiry cron (issue #1182).
 *
 * The job used to pass `"CANCELLED"` as the notification type, which is not a
 * NotificationType member, so Prisma rejected every expiry notification. The
 * job must now notify clients with the JOB_EXPIRED type for both unfunded and
 * funded jobs that passed their deadline.
 */
import { jest, describe, it, expect, beforeEach } from "@jest/globals";

const mockJobFindMany = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const mockJobUpdate = jest.fn<(...args: unknown[]) => Promise<unknown>>();

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client") as { NotificationType: unknown };
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      job: { findMany: mockJobFindMany, update: mockJobUpdate },
    })),
    NotificationType: actual.NotificationType,
  };
});

const mockSendNotification = jest.fn<(...args: unknown[]) => Promise<unknown>>();
jest.mock("../services/notification.service", () => ({
  NotificationService: { sendNotification: mockSendNotification },
}));

jest.mock("../lib/logger", () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock("ioredis", () => jest.fn());

import { NotificationType } from "@prisma/client";
import { expireJobs } from "../jobs/expiry.job";

describe("expireJobs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockJobUpdate.mockResolvedValue({});
    mockSendNotification.mockResolvedValue(null);
  });

  it("marks unfunded expired jobs EXPIRED and notifies the client with JOB_EXPIRED", async () => {
    mockJobFindMany
      .mockResolvedValueOnce([{ id: "job-1", title: "Logo design", clientId: "client-1" }])
      .mockResolvedValueOnce([]);

    await expireJobs();

    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: "job-1" },
      data: { status: "EXPIRED" },
    });
    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "client-1",
        type: NotificationType.JOB_EXPIRED,
        title: "Job Expired",
      }),
    );
    expect(NotificationType.JOB_EXPIRED).toBe("JOB_EXPIRED");
  });

  it("marks funded expired jobs EXPIRED and notifies the client with JOB_EXPIRED", async () => {
    mockJobFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "job-2", title: "Smart contract audit", clientId: "client-2", contractJobId: "42" },
      ]);

    await expireJobs();

    expect(mockJobUpdate).toHaveBeenCalledWith({
      where: { id: "job-2" },
      data: { status: "EXPIRED" },
    });
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "client-2",
        type: NotificationType.JOB_EXPIRED,
        title: "Funded Job Expired",
      }),
    );
  });

  it("only ever sends NotificationType enum members", async () => {
    mockJobFindMany
      .mockResolvedValueOnce([{ id: "job-1", title: "A", clientId: "c-1" }])
      .mockResolvedValueOnce([{ id: "job-2", title: "B", clientId: "c-2", contractJobId: null }]);

    await expireJobs();

    const validTypes = Object.values(NotificationType) as string[];
    for (const call of mockSendNotification.mock.calls) {
      const params = call[0] as { type: string };
      expect(validTypes).toContain(params.type);
    }
    expect(mockSendNotification).toHaveBeenCalledTimes(2);
  });

  it("keeps processing other funded jobs when one fails", async () => {
    mockJobFindMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: "job-a", title: "A", clientId: "c-a", contractJobId: null },
        { id: "job-b", title: "B", clientId: "c-b", contractJobId: null },
      ]);
    mockJobUpdate.mockRejectedValueOnce(new Error("db down")).mockResolvedValue({});

    await expireJobs();

    expect(mockSendNotification).toHaveBeenCalledTimes(1);
    expect(mockSendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "c-b", type: NotificationType.JOB_EXPIRED }),
    );
  });
});
