import { createServer } from "http";
import type { Server as HttpServer } from "http";
import ioc from "socket.io-client";
import jwt from "jsonwebtoken";
import { config } from "../../config";
import { FakeRedisBus } from "../../lib/__tests__/testUtils/fakeRedis";

declare global {
  // `var` is required here: TypeScript ambient global declarations don't
  // support `let`/`const`.
  // eslint-disable-next-line no-var
  var __MULTI_INSTANCE_REDIS_BUS__: FakeRedisBus;
  // eslint-disable-next-line no-var
  var __CAPTURED_WORKERS__: Array<{ name: string; processor: (job: unknown) => Promise<void> }>;
}

/**
 * Presence TTL is short and the heartbeat is set far beyond this file's
 * runtime, so a connected socket's presence key only survives if something
 * explicitly refreshes it. That lets the "crash" test simulate an instance
 * dying right after accepting a connection — no heartbeat ever runs again,
 * and no clean disconnect fires either — by simply not touching the socket
 * and letting the TTL lapse on its own.
 */
process.env.PRESENCE_TTL_SECONDS = "2";
process.env.PRESENCE_HEARTBEAT_MS = "60000";

// One bus shared by every isolated module registry below == one physical
// Redis server shared by every simulated backend instance.
const redisBus = new FakeRedisBus();
globalThis.__MULTI_INSTANCE_REDIS_BUS__ = redisBus;
globalThis.__CAPTURED_WORKERS__ = [];

jest.mock("../../lib/redis", () => {
  // jest.mock factories are hoisted above imports and can't close over
  // module-scoped bindings, so this must stay a require().
  // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
  const { createFakeRedisClient } = require("../../lib/__tests__/testUtils/fakeRedis");
  const client = createFakeRedisClient(globalThis.__MULTI_INSTANCE_REDIS_BUS__);
  return {
    __esModule: true,
    default: {
      getInstance: () => client,
      isRedisConnected: () => true,
      connect: async () => {},
      disconnect: async () => {},
    },
  };
});
jest.mock("../../lib/token-version", () => ({
  getCurrentTokenVersion: jest.fn().mockResolvedValue(0),
}));

jest.mock("../../lib/user-cache", () => ({
  getCachedUserAuthData: jest.fn().mockImplementation((userId: string) =>
    Promise.resolve({
      id: userId,
      role: "CLIENT",
      emailVerified: true,
      deletedAt: null,
      isSuspended: false,
      suspendReason: null,
    }),
  ),
}));

// jest.setup.ts stubs this module out globally (it constructs a real BullMQ
// Queue/Worker at import time, which would otherwise try to open a real Redis
// connection in every test). This file needs the *real* worker logic so the
// live-vs-pending delivery decision actually gets exercised.
jest.unmock("../../lib/notification-queue");

// bullmq's Worker constructor is captured instead of run for real, so the
// test can invoke the *actual* notification-queue.ts processor directly —
// as if BullMQ had just delivered a job — without needing a real Redis/BullMQ
// deployment to drive the queue.
jest.mock("bullmq", () => {
  class MockQueue {
    add = jest.fn();
    constructor(_name: string, _opts: unknown) {}
  }
  class MockWorker {
    on = jest.fn();
    close = jest.fn().mockResolvedValue(undefined);
    constructor(name: string, processor: (job: unknown) => Promise<void>, _opts: unknown) {
      const bucket = (globalThis.__CAPTURED_WORKERS__ ??= []);
      bucket.push({ name, processor });
    }
  }
  return { Queue: MockQueue, Worker: MockWorker, Job: class {}, QueueEvents: class {} };
});

jest.mock("../../services/notification.service", () => ({
  NotificationService: {
    deliverExternalNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    notification: {
      update: jest.fn().mockResolvedValue(undefined),
      findUnique: jest.fn().mockImplementation(async ({ where }: { where: { id: string } }) => ({
        id: where.id,
      })),
    },
    pendingNotification: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue(undefined),
      create: jest.fn().mockResolvedValue(undefined),
    },
    message: {
      create: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

interface PrismaMock {
  pendingNotification: { create: jest.Mock };
}

interface TestInstance {
  httpServer: HttpServer;
  port: number;
  isUserOnline: (userId: string) => Promise<boolean>;
  prismaMock: PrismaMock;
  workerProcessor: (job: { data: Record<string, unknown> }) => Promise<void>;
}

const instances: TestInstance[] = [];
const clients: ReturnType<typeof ioc>[] = [];

/** Boots one isolated copy of socket/index.ts — simulating one backend process. */
async function startInstance(): Promise<TestInstance> {
  let initSocket: (server: HttpServer) => unknown;
  let isUserOnline: (userId: string) => Promise<boolean>;
  let prismaMock: PrismaMock;

  jest.isolateModules(() => {
    // jest.isolateModules needs call-time require() to force a fresh module
    // registry per simulated instance; a static import would be cached once
    // and shared across instances, defeating the isolation.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    ({ initSocket, isUserOnline } = require("../index"));
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const { PrismaClient } = require("@prisma/client");
    prismaMock = new PrismaClient();
  });

  const capturedWorkers: Array<{ processor: (job: unknown) => Promise<void> }> =
    globalThis.__CAPTURED_WORKERS__;
  const before = capturedWorkers.length;

  const httpServer = createServer();
  initSocket!(httpServer);
  const workerEntry = capturedWorkers[before];

  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  const addr = httpServer.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;

  const instance: TestInstance = {
    httpServer,
    port,
    isUserOnline: isUserOnline!,
    prismaMock: prismaMock!,
    workerProcessor: workerEntry.processor as (job: { data: Record<string, unknown> }) => Promise<void>,
  };
  instances.push(instance);
  return instance;
}

function connectClient(port: number, userId: string): Promise<ReturnType<typeof ioc>> {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return new Promise((resolve, reject) => {
    const socket = ioc(`http://localhost:${port}`, {
      auth: { token },
      forceNew: true,
      transports: ["websocket"],
    });
    socket.on("connect", () => resolve(socket));
    socket.on("connect_error", (err: Error) => {
      socket.disconnect();
      reject(err);
    });
    clients.push(socket);
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(async () => {
  for (const client of clients.splice(0)) {
    client.disconnect();
  }
  for (const instance of instances.splice(0)) {
    await new Promise<void>((resolve) => instance.httpServer.close(() => resolve()));
  }
});

describe("cluster-aware socket presence across multiple backend instances", () => {
  it("delivers a notification triggered on instance A live to a user connected only to instance B", async () => {
    const instanceA = await startInstance();
    const instanceB = await startInstance();

    const userId = "user-cross-instance";
    const client = await connectClient(instanceB.port, userId);

    // let the connection handler's presence write land
    await wait(50);

    expect(await instanceA.isUserOnline(userId)).toBe(true);

    const received = new Promise((resolve) => client.once("notification:new", resolve));

    await instanceA.workerProcessor({
      data: {
        userId,
        type: "NEW_MESSAGE",
        title: "New message",
        message: "hi",
        metadata: {},
        notificationId: "notif-cross-1",
        priority: 2,
      },
    });

    const payload = await received;
    expect((payload as { id: string }).id).toBe("notif-cross-1");
    expect(instanceA.prismaMock.pendingNotification.create).not.toHaveBeenCalled();
  });

  it("queues the notification as pending when the user isn't connected to any instance", async () => {
    const instanceA = await startInstance();
    const userId = "user-offline-everywhere";

    expect(await instanceA.isUserOnline(userId)).toBe(false);

    await instanceA.workerProcessor({
      data: {
        userId,
        type: "NEW_MESSAGE",
        title: "New message",
        message: "hi",
        metadata: {},
        notificationId: "notif-offline-1",
        priority: 3,
      },
    });

    expect(instanceA.prismaMock.pendingNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId, notificationId: "notif-offline-1" }),
      }),
    );
  });

  it("does not report a user online forever after their instance crashes without a clean disconnect", async () => {
    const instanceA = await startInstance();
    const instanceB = await startInstance();

    const userId = "user-crash";
    await connectClient(instanceB.port, userId);

    await wait(50);
    expect(await instanceA.isUserOnline(userId)).toBe(true);

    // Simulate instance B being killed: nothing refreshes the heartbeat
    // (it's configured to only fire once every 60s) and no disconnect event
    // ever runs on either side, mirroring a process that vanishes mid-flight.
    await wait(2300);

    expect(await instanceA.isUserOnline(userId)).toBe(false);

    await instanceA.workerProcessor({
      data: {
        userId,
        type: "NEW_MESSAGE",
        title: "New message",
        message: "hi",
        metadata: {},
        notificationId: "notif-crash-1",
        priority: 1,
      },
    });

    expect(instanceA.prismaMock.pendingNotification.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId, notificationId: "notif-crash-1" }),
      }),
    );
  });
});
