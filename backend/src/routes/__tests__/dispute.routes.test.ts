import express from "express";
import request from "supertest";
import disputeRoutes from "../dispute.routes";
import { errorHandler } from "../../middleware/error";

describe("Dispute routes auth protection", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/disputes", disputeRoutes);
  app.use(errorHandler);

  it("GET /api/disputes returns 401 when unauthenticated", async () => {
    const response = await request(app).get("/api/disputes");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Access denied. No token provided.",
    });
  });

  it("GET /api/disputes/:id returns 401 when unauthenticated", async () => {
    const response = await request(app).get("/api/disputes/test-dispute-id");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Access denied. No token provided.",
    });
  });

  it("GET /api/disputes/:id/stream returns 401 when unauthenticated", async () => {
    const response = await request(app)
      .get("/api/disputes/test-dispute-id/stream")
      .set("Accept", "text/event-stream");

    expect(response.status).toBe(401);
    expect(response.body).toEqual({
      error: "Access denied. No token provided.",
    });
  });
});

describe("Dispute webhook webhook secret validation", () => {
  const app = express();
  app.use(express.json());
  app.use("/api/disputes", disputeRoutes);
  app.use(errorHandler);

  const originalSecret = process.env.WEBHOOK_SECRET;

  afterEach(() => {
    process.env.WEBHOOK_SECRET = originalSecret;
  });

  it("POST /api/disputes/webhook returns 500 when WEBHOOK_SECRET is not configured", async () => {
    delete process.env.WEBHOOK_SECRET;
    
    const response = await request(app)
      .post("/api/disputes/webhook")
      .set("x-stellar-signature", "some-signature")
      .send({ type: "DISPUTE_RESOLVED", disputeId: "123" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: "Server misconfiguration: webhook secret is not set.",
    });
  });
});
