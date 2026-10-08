import express, { Request, Response, NextFunction } from "express";
import request from "supertest";
import userRouter from "../user.routes";
import { ReputationCacheService } from "../../services/reputation-cache.service";
import { ReputationService } from "../../services/reputation.service";

// Mock ReputationCacheService and ReputationService
jest.mock("../../services/reputation-cache.service", () => ({
  ReputationCacheService: {
    getCachedReputation: jest.fn(),
  },
}));

jest.mock("../../services/reputation.service", () => ({
  ReputationService: {
    getReputation: jest.fn(),
  },
}));

jest.mock("@prisma/client", () => {
  const mUser = {
    findMany: jest.fn(),
    count: jest.fn(),
  };
  return {
    PrismaClient: jest.fn(() => ({
      user: mUser,
    })),
    __mockUser: mUser,
  };
});

interface MockUserModel {
  findMany: jest.Mock;
  count: jest.Mock;
}

const { __mockUser: mockUser } = jest.requireMock("@prisma/client") as unknown as {
  __mockUser: MockUserModel;
};

jest.mock("../../middleware/auth", () => ({
  authenticate: jest.fn((req, res, next) => next()),
}));

jest.mock("../../middleware/validation", () => ({
  validate: jest.fn(
    () => (req: Request, res: Response, next: NextFunction) => next(),
  ),
}));

jest.mock("../../lib/logger", () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

jest.mock("../../lib/cache", () => ({
  cache: jest.fn(),
  generateUserCacheKey: jest.fn(),
  invalidateCacheKey: jest.fn(),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/users", userRouter);
  return app;
}

describe("GET /users", () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("should use ReputationCacheService instead of ReputationService for freelancers", async () => {
    mockUser.findMany.mockResolvedValue([
      {
        id: "user1",
        role: "FREELANCER",
        walletAddress: "GASDFG123456",
      },
      {
        id: "user2",
        role: "CLIENT",
        walletAddress: "GASDFG789012",
      },
    ]);
    mockUser.count.mockResolvedValue(2);

    (ReputationCacheService.getCachedReputation as jest.Mock).mockResolvedValue({
      tier: "SILVER",
      score: 100,
      disputeLossRate: 0,
      endorsementWeight: 50,
      lastUpdated: 123456789,
    });

    const res = await request(app).get("/users?page=1&limit=10");

    expect(res.status).toBe(200);
    expect(res.body.users).toHaveLength(2);
    expect(res.body.users[0].reputation).toBeDefined();
    
    // Verify ReputationCacheService was called for the freelancer
    expect(ReputationCacheService.getCachedReputation).toHaveBeenCalledWith("GASDFG123456");
    expect(ReputationCacheService.getCachedReputation).toHaveBeenCalledTimes(1);

    // Verify direct on-chain ReputationService was NOT called
    expect(ReputationService.getReputation).not.toHaveBeenCalled();
  });
});
