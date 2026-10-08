import express from "express";
import request from "supertest";
import freelancerRouter from "../freelancer.routes";

jest.mock("@prisma/client", () => {
  const actual = jest.requireActual("@prisma/client") as typeof import("@prisma/client");
  const mockPrisma = {
    $queryRaw: jest.fn(),
  };
  return {
    ...actual,
    PrismaClient: jest.fn(() => mockPrisma),
  };
});

import { PrismaClient } from "@prisma/client";

const prismaMock = new PrismaClient() as unknown as {
  $queryRaw: jest.Mock;
};

const app = express();
app.use(express.json());
app.use("/api/freelancers", freelancerRouter);

afterEach(() => jest.clearAllMocks());

describe("GET /api/freelancers/search", () => {
  it("returns 200 with empty data when no freelancers match", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ n: 0n }])
      .mockResolvedValueOnce([]);

    const res = await request(app).get("/api/freelancers/search");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: [],
      meta: { total: 0, page: 1, limit: 12, totalPages: 0 },
    });
    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("returns mapped freelancer rows and meta", async () => {
    prismaMock.$queryRaw
      .mockResolvedValueOnce([{ n: 1n }])
      .mockResolvedValueOnce([
        {
          id: "u1",
          username: "alice",
          avatarUrl: "https://x/a.png",
          bio: "Hi",
          skills: ["Rust"],
          averageRating: 4.7,
          availability: true,
          completedJobs: 3,
        },
      ]);

    const res = await request(app).get("/api/freelancers/search?page=1&limit=10");

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toEqual({
      id: "u1",
      name: "alice",
      avatarUrl: "https://x/a.png",
      bio: "Hi",
      skills: ["Rust"],
      averageRating: 4.7,
      completedJobs: 3,
      isAvailable: true,
    });
    expect(res.body.meta).toEqual({
      total: 1,
      page: 1,
      limit: 10,
      totalPages: 1,
    });
  });

  it("returns 400 for invalid minRating", async () => {
    const res = await request(app).get("/api/freelancers/search?minRating=99");
    expect(res.status).toBe(400);
    expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
  });
});
