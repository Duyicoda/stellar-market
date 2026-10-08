import request from "supertest";
import express from "express";

type MockPrismaClient = {
  skill: { findMany: jest.Mock };
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    skill: { findMany: jest.fn() },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

import { PrismaClient } from "@prisma/client";
import skillRouter from "../skill.routes";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;

const app = express();
app.use(express.json());
app.use("/api/skills", skillRouter);

beforeEach(() => {
  jest.clearAllMocks();
});

describe("GET /api/skills", () => {
  it("returns up to 100 skills when q is omitted", async () => {
    const mockSkills = [{ id: "1", name: "React", category: "Frontend" }];
    prismaMock.skill.findMany.mockResolvedValue(mockSkills);

    const res = await request(app).get("/api/skills");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skills: mockSkills });
    expect(prismaMock.skill.findMany).toHaveBeenCalledWith({
      orderBy: { name: "asc" },
      take: 100,
      select: { id: true, name: true, category: true },
    });
  });

  it("returns matching skills up to the 10-result limit", async () => {
    prismaMock.skill.findMany.mockResolvedValue([
      { id: "1", name: "React", category: "Frontend" },
      { id: "2", name: "React Native", category: "Mobile" },
    ]);

    const res = await request(app).get("/api/skills?q=rea");

    expect(res.status).toBe(200);
    expect(res.body.skills).toHaveLength(2);
    expect(prismaMock.skill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { name: { contains: "rea", mode: "insensitive" } },
        take: 10,
      }),
    );
  });
});
