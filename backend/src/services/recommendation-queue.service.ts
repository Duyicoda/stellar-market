import { Queue, Worker } from "bullmq";
import RedisClient from "../lib/redis";
import { RecommendationService } from "./recommendation.service";
import { logger } from "../lib/logger";

const connection = RedisClient.getInstance();

// BullMQ's Worker issues blocking Redis commands and requires a connection with
// maxRetriesPerRequest: null (the shared app-wide client uses a finite retry count
// for its own non-blocking commands, so the Worker gets its own duplicated connection).
const workerConnection = connection.duplicate({
  maxRetriesPerRequest: null,
  lazyConnect: false,
});

export type RecommendationRebuildJob = {
  jobId: string;
};

let queue: Queue<RecommendationRebuildJob> | null = null;
let worker: Worker<RecommendationRebuildJob> | null = null;

function getQueue(): Queue<RecommendationRebuildJob> {
  if (!queue) {
    queue = new Queue<RecommendationRebuildJob>("recommendation-rebuild", {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: 500,
        removeOnFail: false,
      },
    });
  }
  return queue;
}

export function getRecommendationRebuildQueue(): Queue<RecommendationRebuildJob> {
  return getQueue();
}

function startRecommendationWorker(): void {
  if (worker) return;

  worker = new Worker<RecommendationRebuildJob>(
    "recommendation-rebuild",
    async (job) => {
      await RecommendationService.rebuildRecommendationsForJob(job.data.jobId);
    },
    {
      connection: workerConnection,
      concurrency: 5,
    },
  );

  worker.on("failed", (job, err) => {
    if (job) {
      logger.error(
        { jobId: job.id, jobData: job.data, err },
        "Recommendation rebuild job failed after all retries",
      );
    }
  });

  logger.info("Recommendation rebuild worker started");
}

export class RecommendationQueueService {
  static async enqueueRebuild(jobId: string): Promise<void> {
    await getQueue().add("rebuild", { jobId });
  }

  static startWorker(): void {
    startRecommendationWorker();
  }

  static async stopWorker(): Promise<void> {
    if (worker) {
      await worker.close();
      worker = null;
    }
    workerConnection.disconnect();
  }
}
