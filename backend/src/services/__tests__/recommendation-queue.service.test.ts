// eslint-disable-next-line @typescript-eslint/no-explicit-any
const capturedQueueOptions: Array<{ name: string; opts: any }> = [];

const queueAddMock = jest.fn();
const queueCloseMock = jest.fn().mockResolvedValue(undefined);
const workerOnMock = jest.fn();
const workerCloseMock = jest.fn().mockResolvedValue(undefined);

jest.mock("bullmq", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const Queue = jest.fn((name: string, opts: any) => {
    capturedQueueOptions.push({ name, opts });
    return {
      add: queueAddMock,
      close: queueCloseMock,
      name: "recommendation-rebuild",
    };
  });
  const Worker = jest.fn(() => ({
    close: workerCloseMock,
    on: workerOnMock,
  }));
  return { Queue, Worker };
});

jest.mock("../recommendation.service", () => ({
  RecommendationService: {
    rebuildRecommendationsForJob: jest.fn(),
  },
}));

import { RecommendationQueueService } from "../recommendation-queue.service";

describe("RecommendationQueueService durability (#945)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    RecommendationQueueService.stopWorker();
  });

  it("enqueues rebuild job via BullMQ with correct payload", async () => {
    await RecommendationQueueService.enqueueRebuild("job-123");

    expect(queueAddMock).toHaveBeenCalledWith("rebuild", { jobId: "job-123" });
  });

  it("configures retry with attempts=3 and exponential backoff", () => {
    expect(capturedQueueOptions.length).toBeGreaterThanOrEqual(1);
    const config = capturedQueueOptions[0];
    expect(config.name).toBe("recommendation-rebuild");
    expect(config.opts.defaultJobOptions).toMatchObject({
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
    });
  });

  it("retains failed jobs for dead-letter inspection", () => {
    expect(capturedQueueOptions.length).toBeGreaterThanOrEqual(1);
    const config = capturedQueueOptions[0];
    expect(config.opts.defaultJobOptions.removeOnFail).toBe(false);
  });

  it("worker registers failed event handler for dead-letter tracking", () => {
    RecommendationQueueService.startWorker();
    expect(workerOnMock).toHaveBeenCalledWith("failed", expect.any(Function));
    RecommendationQueueService.stopWorker();
  });

  it("enqueue failure propagates to caller for handling", async () => {
    queueAddMock.mockRejectedValue(new Error("Redis unreachable"));

    await expect(RecommendationQueueService.enqueueRebuild("job-456")).rejects.toThrow("Redis unreachable");
  });

  it("stopWorker closes the worker", async () => {
    RecommendationQueueService.startWorker();
    await RecommendationQueueService.stopWorker();
    expect(workerCloseMock).toHaveBeenCalled();
  });
});
