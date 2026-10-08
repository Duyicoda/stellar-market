import { PrismaClient, EscrowEventType, JobStatus, EscrowStatus } from "@prisma/client";
import { handleEscrowEvent } from "../services/escrow-projection.service";
import net from "net";

jest.mock("../services/notification.service", () => ({
  NotificationService: {
    sendNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

function checkPostgresReachable(port = 5432, host = "localhost"): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const onError = () => {
      socket.destroy();
      resolve(false);
    };
    socket.setTimeout(1000);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", onError);
    socket.once("timeout", onError);
    socket.connect(port, host);
  });
}

describe("Escrow Database Integration (Real DB Constraints)", () => {
  let prisma: PrismaClient;
  let isDbReachable = false;
  let testJobId: string;
  const contractJobId = "db-test-contract-123";

  beforeAll(async () => {
    // Fast TCP port check to prevent Jest hook timeouts when PG is offline
    const isPortOpen = await checkPostgresReachable();
    if (!isPortOpen) {
      console.warn("PostgreSQL port 5432 is not open. Skipping database constraint integration tests.");
      return;
    }

    prisma = new PrismaClient();
    try {
      await prisma.$connect();
      isDbReachable = true;
    } catch {
      console.warn("Real database is not reachable. Skipping database constraint integration tests.");
    }
  });

  afterAll(async () => {
    if (prisma) {
      await prisma.$disconnect();
    }
  });

  beforeEach(async () => {
    if (!isDbReachable) return;

    // Clean up any test records left behind
    await prisma.escrowEvent.deleteMany({ where: { contractJobId } });
    await prisma.dispute.deleteMany({ where: { job: { contractJobId } } });
    await prisma.job.deleteMany({ where: { contractJobId } });

    // Ensure users exist
    const client = await prisma.user.upsert({
      where: { username: "db-test-client" },
      update: {},
      create: {
        username: "db-test-client",
        email: "client@test.com",
        walletAddress: "GCLIENT_TEST",
      },
    });

    const job = await prisma.job.create({
      data: {
        title: "Test DB Integration Job",
        description: "Test description",
        budget: 1000,
        category: "Development",
        clientId: client.id,
        contractJobId,
        status: JobStatus.OPEN,
        escrowStatus: EscrowStatus.UNFUNDED,
        deadline: new Date(Date.now() + 86400000),
      },
    });
    testJobId = job.id;
  });

  afterEach(async () => {
    if (!isDbReachable) return;
    await prisma.escrowEvent.deleteMany({ where: { contractJobId } });
    await prisma.dispute.deleteMany({ where: { job: { contractJobId } } });
    await prisma.job.deleteMany({ where: { contractJobId } });
  });

  it("should enforce uniqueness on contractJobId, eventType, and ledgerSeq at database level", async () => {
    if (!isDbReachable) {
      return;
    }

    // 1. Process event 1
    await handleEscrowEvent({
      jobId: testJobId,
      contractJobId,
      eventType: EscrowEventType.JOB_FUNDED,
      ledgerSeq: 10,
      txHash: "tx-first",
      payload: {},
    });

    const events = await prisma.escrowEvent.findMany({
      where: { jobId: testJobId },
    });
    expect(events.length).toBe(1);

    // 2. Try to insert duplicate event (same contractJobId, eventType, ledgerSeq)
    // It should hit P2002 at the database level and be handled idempotently (silently skipped)
    await expect(
      handleEscrowEvent({
        jobId: testJobId,
        contractJobId,
        eventType: EscrowEventType.JOB_FUNDED,
        ledgerSeq: 10,
        txHash: "tx-duplicate",
        payload: {},
      })
    ).resolves.not.toThrow();

    // Verify only one event was written to the database
    const eventsAfter = await prisma.escrowEvent.findMany({
      where: { jobId: testJobId },
    });
    expect(eventsAfter.length).toBe(1);
  });
});
