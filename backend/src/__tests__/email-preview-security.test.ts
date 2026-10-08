/**
 * Security tests for GET /admin/email-preview/:template (issue #1211).
 *
 * Covers both reported vulnerabilities:
 *   1. authenticate + requireAdmin enforced in every environment, not just prod.
 *   2. template parameter allowlisted against path traversal / abs paths / etc.
 *
 * Router is mounted under /admin in routes/index.ts, so requests land at
 * GET /admin/email-preview/:template.  In these tests we mount the router
 * under /admin/email-preview to keep parity with the real wiring.
 */

type MockPrismaClient = {
  user: {
    findUnique: jest.Mock;
  };
  $disconnect: jest.Mock;
};

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    user: { findUnique: jest.fn() },
    $disconnect: jest.fn(),
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
    UserRole: { CLIENT: "CLIENT", FREELANCER: "FREELANCER", ADMIN: "ADMIN" },
  };
});

jest.mock("jsonwebtoken", () => ({
  verify: jest.fn().mockReturnValue({ userId: "u-1" }),
  sign: jest.fn().mockReturnValue("mock-token"),
}));

jest.mock("../config", () => ({
  config: {
    jwtSecret: "test-secret",
    stellar: {
      rpcUrl: "https://soroban-testnet.stellar.org",
      escrowContractId: "",
      disputeContractId: "",
      reputationContractId: "",
    },
    smtp: { host: "smtp.test", port: 587, user: "", pass: "", from: "" },
  },
}));

import { PrismaClient, UserRole } from "@prisma/client";
import express from "express";
import request from "supertest";
import emailPreviewRouter from "../routes/admin/emailPreview";
import { getAvailableEmailTemplates } from "../utils/emailTemplateRenderer";

const prismaMock = new PrismaClient() as unknown as MockPrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/admin/email-preview", emailPreviewRouter);
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });
  return app;
}

function withAuthHeader(req: request.Test, role: UserRole): request.Test {
  prismaMock.user.findUnique.mockResolvedValueOnce({
    id: "u-1",
    role,
    emailVerified: true,
    deletedAt: null,
  });
  return req.set("Authorization", "Bearer mock-token");
}

afterEach(() => jest.clearAllMocks());

const AVAILABLE = getAvailableEmailTemplates();
const VALID_TEMPLATE = AVAILABLE[0] ?? "verification";

describe("GET /admin/email-preview/:template (#1211)", () => {
  it("rejects unauthenticated requests in test environment (no prod guard)", async () => {
    const app = buildApp();
    const res = await request(app).get(
      `/admin/email-preview/${VALID_TEMPLATE}`,
    );
    expect(res.status).toBe(401);
    expect(prismaMock.user.findUnique).not.toHaveBeenCalled();
  });

  it("rejects authenticated non-admin requests (FREELANCER role)", async () => {
    const app = buildApp();
    const res = await withAuthHeader(
      request(app).get(`/admin/email-preview/${VALID_TEMPLATE}`),
      UserRole.FREELANCER,
    );
    expect(res.status).toBe(403);
    expect(res.body?.error).toMatch(/admin/i);
  });

  it("rejects authenticated non-admin requests (CLIENT role)", async () => {
    const app = buildApp();
    const res = await withAuthHeader(
      request(app).get(`/admin/email-preview/${VALID_TEMPLATE}`),
      UserRole.CLIENT,
    );
    expect(res.status).toBe(403);
    expect(res.body?.error).toMatch(/admin/i);
  });

  it.each(AVAILABLE.map((t) => [t]))(
    "succeeds for valid admin request (template=%s)",
    async (tpl: string) => {
      expect(AVAILABLE.length).toBeGreaterThan(0);
      const app = buildApp();
      const res = await withAuthHeader(
        request(app).get(`/admin/email-preview/${tpl}`),
        UserRole.ADMIN,
      );
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
      expect(typeof res.text).toBe("string");
      expect(res.text.length).toBeGreaterThan(0);
    },
  );

  describe("path traversal / invalid name rejection", () => {
    const TRAVERSAL_CASES: Array<[string, string]> = [
      ["relative-up raw", "../package.json"],
      ["relative-up url-encoded", "..%2Fpackage.json"],
      ["double-dot percent-encoded", "%2e%2e%2fpackage.json"],
      ["double-slash escape", `....//${VALID_TEMPLATE}`],
      ["embedded backslash", `${VALID_TEMPLATE}\\..\\layout`],
      ["encoded embedded slash", `layout%2f..%2f${VALID_TEMPLATE}`],
      ["absolute unix", "/etc/passwd"],
      ["absolute windows-style", `\\templates\\email\\handlebars\\${VALID_TEMPLATE}`],
      ["includes extension", `${VALID_TEMPLATE}.hbs`],
      ["semicolon shell", `${VALID_TEMPLATE};cat%20/etc/passwd`],
      ["null byte suffix", `${VALID_TEMPLATE}\x00`],
      ["dot-only prefix", `../${VALID_TEMPLATE}`],
      ["dot-only suffix", `${VALID_TEMPLATE}/..`],
      ["space in name", `${VALID_TEMPLATE} foo`],
    ];

    it.each(TRAVERSAL_CASES)(
      "rejects %s",
      async (_label: string, attempt: string) => {
        const app = buildApp();
        const res = await withAuthHeader(
          request(app).get(
            `/admin/email-preview/${encodeURI(attempt)}`,
          ),
          UserRole.ADMIN,
        );
        expect([400, 404]).toContain(res.status);
        expect(res.headers["content-type"] ?? "").not.toMatch(/text\/html/);
      },
    );
  });
});
