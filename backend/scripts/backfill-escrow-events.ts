import { PrismaClient, EscrowEventType, JobStatus, EscrowStatus } from "@prisma/client";

const { logger, installRequestIdConsolePatch } = require("../src/lib/logger");
installRequestIdConsolePatch();

const prisma = new PrismaClient();

async function backfill() {
  logger.info("Starting backfill of escrow events...");

  const jobs = await prisma.job.findMany({
    include: {
      escrowEvents: true,
      dispute: true,
    },
  });

  logger.info({ count: jobs.length }, `Found ${jobs.length} jobs to process.`);

  let createdEventsCount = 0;

  for (const job of jobs) {
    if (job.escrowEvents.length > 0) {
      logger.info({ jobId: job.id }, `Job ${job.id} already has events. Skipping.`);
      continue;
    }

    const contractJobId = job.contractJobId ?? `db-only-${job.id}`;
    const txHash = "backfill";
    const eventsToCreate: { eventType: EscrowEventType; ledgerSeq: number; payload: any }[] = [];

    // Always start with JOB_CREATED
    eventsToCreate.push({
      eventType: EscrowEventType.JOB_CREATED,
      ledgerSeq: 1,
      payload: {},
    });

    if (job.escrowStatus === EscrowStatus.FUNDED || job.status === JobStatus.IN_PROGRESS) {
      eventsToCreate.push({
        eventType: EscrowEventType.JOB_FUNDED,
        ledgerSeq: 2,
        payload: {},
      });
    } else if (job.escrowStatus === EscrowStatus.COMPLETED || job.status === JobStatus.COMPLETED) {
      eventsToCreate.push({
        eventType: EscrowEventType.JOB_FUNDED,
        ledgerSeq: 2,
        payload: {},
      });
      eventsToCreate.push({
        eventType: EscrowEventType.PAYMENT_RELEASED,
        ledgerSeq: 3,
        payload: { amount: job.budget.toString() },
      });
    } else if (job.escrowStatus === EscrowStatus.DISPUTED || job.status === JobStatus.DISPUTED) {
      eventsToCreate.push({
        eventType: EscrowEventType.JOB_FUNDED,
        ledgerSeq: 2,
        payload: {},
      });
      eventsToCreate.push({
        eventType: EscrowEventType.DISPUTE_OPENED,
        ledgerSeq: 3,
        payload: {
          onChainDisputeId: job.dispute?.onChainDisputeId ?? `db-only-${job.id}`,
        },
      });
    } else if (job.status === JobStatus.CANCELLED) {
      eventsToCreate.push({
        eventType: EscrowEventType.JOB_FUNDED,
        ledgerSeq: 2,
        payload: {},
      });
      if (job.dispute) {
        eventsToCreate.push({
          eventType: EscrowEventType.DISPUTE_OPENED,
          ledgerSeq: 3,
          payload: {
            onChainDisputeId: job.dispute.onChainDisputeId ?? `db-only-${job.id}`,
          },
        });
        const rawStatus = job.dispute.outcome === "CLIENT_WINS" ? "ResolvedForClient" : "RefundedBoth";
        eventsToCreate.push({
          eventType: EscrowEventType.DISPUTE_RESOLVED,
          ledgerSeq: 4,
          payload: {
            onChainDisputeId: job.dispute.onChainDisputeId ?? `db-only-${job.id}`,
            rawStatus,
          },
        });
      } else {
        eventsToCreate.push({
          eventType: EscrowEventType.REFUNDED,
          ledgerSeq: 3,
          payload: {},
        });
      }
    } else if (job.status === JobStatus.EXPIRED) {
      eventsToCreate.push({
        eventType: EscrowEventType.EXPIRED,
        ledgerSeq: 2,
        payload: {},
      });
    }

    // Insert synthesized events
    for (const ev of eventsToCreate) {
      await prisma.escrowEvent.create({
        data: {
          jobId: job.id,
          contractJobId,
          eventType: ev.eventType,
          ledgerSeq: ev.ledgerSeq,
          txHash,
          payload: ev.payload,
        },
      });
      createdEventsCount++;
    }

    logger.info({ jobId: job.id, synthesized: eventsToCreate.length }, `Job ${job.id}: Synthesized ${eventsToCreate.length} events.`);
  }

  logger.info({ createdEventsCount }, `Backfill complete. Synthesized ${createdEventsCount} events.`);
}

backfill()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
