import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import { Buffer } from "buffer";
import { config } from "../../config";
import uploadRouter from "../upload.routes";
import { UPLOAD_DIR } from "../../config/upload";

const mockDisputeFindUnique = jest.fn();
const mockAttachmentCreate = jest.fn();

jest.mock("@prisma/client", () => {
  const mockPrisma = {
    job: { findUnique: jest.fn().mockResolvedValue(null) },
    dispute: {
      findUnique: (...args: unknown[]) => mockDisputeFindUnique(...args),
    },
    attachment: {
      create: (...args: unknown[]) => mockAttachmentCreate(...args),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ role: "CLIENT", emailVerified: true }),
    },
  };
  return { PrismaClient: jest.fn(() => mockPrisma) };
});

jest.mock("../../utils/virusScanner", () => ({
  scanFile: jest.fn().mockResolvedValue({ isInfected: false, skipped: true }),
}));

jest.mock("../../utils/auditLogger", () => ({
  auditLogger: { log: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use("/api/uploads", uploadRouter);

const CLIENT_ID = "00000000-0000-4000-8000-000000000001";
const FREELANCER_ID = "00000000-0000-4000-8000-000000000002";
const STRANGER_ID = "00000000-0000-4000-8000-000000000099";

function authHeader(userId = CLIENT_ID) {
  const token = jwt.sign({ userId }, config.jwtSecret, { expiresIn: "1h" });
  return { Authorization: `Bearer ${token}` };
}

describe("POST /api/uploads Dispute & Rate Limit Validation", () => {
  const testDir = path.join(__dirname, "test_dispute_files");
  const validJpegPath = path.join(testDir, "valid.jpg");

  beforeAll(() => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir);
    if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

    // Valid JPEG header
    const jpegBuffer = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
    fs.writeFileSync(validJpegPath, jpegBuffer);
  });

  afterAll(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns 404 when disputeId does not exist", async () => {
    mockDisputeFindUnique.mockResolvedValue(null);

    const res = await request(app)
      .post("/api/uploads")
      .set(authHeader(CLIENT_ID))
      .field("disputeId", "non-existent-dispute")
      .attach("file", validJpegPath, { contentType: "image/jpeg" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("Dispute not found");
    expect(mockAttachmentCreate).not.toHaveBeenCalled();
  });

  it("returns 403 when uploader is not party to the dispute", async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: "dispute-123",
      clientId: CLIENT_ID,
      freelancerId: FREELANCER_ID,
    });

    const res = await request(app)
      .post("/api/uploads")
      .set(authHeader(STRANGER_ID))
      .field("disputeId", "dispute-123")
      .attach("file", validJpegPath, { contentType: "image/jpeg" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Only dispute participants can upload files");
    expect(mockAttachmentCreate).not.toHaveBeenCalled();
  });

  it("returns 201 when uploader is a participant of the dispute", async () => {
    mockDisputeFindUnique.mockResolvedValue({
      id: "dispute-123",
      clientId: CLIENT_ID,
      freelancerId: FREELANCER_ID,
    });
    mockAttachmentCreate.mockResolvedValue({
      id: "att-123",
      uploaderId: CLIENT_ID,
      disputeId: "dispute-123",
      filename: "test.jpg",
      originalName: "valid.jpg",
      mimeType: "image/jpeg",
      size: 12,
    });

    const res = await request(app)
      .post("/api/uploads")
      .set(authHeader(CLIENT_ID))
      .field("disputeId", "dispute-123")
      .attach("file", validJpegPath, { contentType: "image/jpeg" });

    expect(res.status).toBe(201);
    expect(mockAttachmentCreate).toHaveBeenCalled();
  });
});
