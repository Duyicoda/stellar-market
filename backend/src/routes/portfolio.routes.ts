import { Router, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";
import fs from "fs";
import path from "path";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { logger } from "../lib/logger";
import {
  portfolioUpload,
  PORTFOLIO_UPLOAD_DIR,
  PORTFOLIO_MAX_ITEMS,
  PORTFOLIO_MAX_FILE_SIZE,
} from "../config/upload";
import { formatFileSize } from "../utils/fileValidation";

const router = Router();
const prisma = new PrismaClient();

const createPortfolioSchema = {
  body: z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
  }),
};

const updatePortfolioSchema = {
  params: z.object({ id: z.string() }),
  body: z.object({
    title: z.string().min(1).max(100).optional(),
    description: z.string().max(500).nullable().optional(),
  }),
};

const reorderPortfolioSchema = {
  body: z.object({
    ids: z.array(z.string()).min(1),
  }),
};

/**
 * GET /api/portfolio/files/:filename
 * Serve portfolio files publicly
 */
router.get("/files/:filename", (req, res) => {
  const filename = req.params.filename as string;
  if (!filename || filename.includes("..")) {
    return res.status(400).json({ error: "Invalid filename" });
  }
  const filePath = path.join(PORTFOLIO_UPLOAD_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found" });
  }

  const ext = path.extname(filename).toLowerCase();
  const mimeMap: Record<string, string> = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".pdf": "application/pdf",
  };
  const contentType = mimeMap[ext] || "application/octet-stream";
  res.setHeader("Content-Type", contentType);
  fs.createReadStream(filePath).pipe(res);
});

/**
 * GET /api/portfolio/user/:userId
 * Get all portfolio items for a user (public)
 */
router.get("/user/:userId", async (req, res) => {
  try {
    const userId = req.params.userId as string;
    const items = await prisma.portfolioItem.findMany({
      where: { userId },
      orderBy: { displayOrder: "asc" },
      select: {
        id: true,
        userId: true,
        title: true,
        description: true,
        fileUrl: true,
        fileName: true,
        mimeType: true,
        size: true,
        displayOrder: true,
        createdAt: true,
      },
    });
    res.json({ items });
  } catch (error) {
    logger.error({ err: error }, "Error fetching portfolio items:");
    res.status(500).json({ error: "Failed to fetch portfolio items" });
  }
});

/**
 * POST /api/portfolio
 * Upload a file and create a portfolio item
 */
router.post(
  "/",
  authenticate,
  portfolioUpload.single("file"),
  validate(createPortfolioSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file uploaded" });
      }

      const { title, description } = req.body as { title: string; description?: string };

      // Enforce max items limit
      const count = await prisma.portfolioItem.count({
        where: { userId: req.userId! },
      });
      if (count >= PORTFOLIO_MAX_ITEMS) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({
          error: `Maximum of ${PORTFOLIO_MAX_ITEMS} portfolio items allowed`,
        });
      }

      // Determine next display order
      const maxOrder = await prisma.portfolioItem.findFirst({
        where: { userId: req.userId! },
        orderBy: { displayOrder: "desc" },
        select: { displayOrder: true },
      });
      const displayOrder = maxOrder ? maxOrder.displayOrder + 1 : 0;

      const fileUrl = `/api/portfolio/files/${req.file.filename}`;

      const item = await prisma.portfolioItem.create({
        data: {
          userId: req.userId!,
          title,
          description: description || null,
          fileUrl,
          fileName: req.file.originalname,
          mimeType: req.file.mimetype,
          size: req.file.size,
          displayOrder,
        },
      });

      res.status(201).json({
        ...item,
        sizeFormatted: formatFileSize(item.size),
      });
    } catch (error) {
      if (req.file && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }
      if ((error as { code?: string })?.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          error: `File too large. Maximum size is ${formatFileSize(PORTFOLIO_MAX_FILE_SIZE)}`,
        });
      }
      logger.error({ err: error }, "Error creating portfolio item:");
      res.status(500).json({ error: "Failed to create portfolio item" });
    }
  },
);

/**
 * PUT /api/portfolio/reorder
 * Reorder portfolio items
 */
router.put(
  "/reorder",
  authenticate,
  validate(reorderPortfolioSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const { ids } = req.body as { ids: string[] };

      // Verify all items belong to the user
      const items = await prisma.portfolioItem.findMany({
        where: { id: { in: ids }, userId: req.userId! },
        select: { id: true },
      });

      if (items.length !== ids.length) {
        return res.status(403).json({ error: "Access denied to one or more items" });
      }

      // Update display order for each item
      await Promise.all(
        ids.map((id, index) =>
          prisma.portfolioItem.update({
            where: { id },
            data: { displayOrder: index },
          }),
        ),
      );

      res.json({ message: "Portfolio items reordered successfully" });
    } catch (error) {
      logger.error({ err: error }, "Error reordering portfolio items:");
      res.status(500).json({ error: "Failed to reorder portfolio items" });
    }
  },
);

/**
 * PUT /api/portfolio/:id
 * Update a portfolio item's title and description
 */
router.put(
  "/:id",
  authenticate,
  validate(updatePortfolioSchema),
  async (req: AuthRequest, res: Response) => {
    try {
      const itemId = req.params.id as string;
      const { title, description } = req.body as {
        title?: string;
        description?: string | null;
      };

      const item = await prisma.portfolioItem.findUnique({ where: { id: itemId } });
      if (!item) {
        return res.status(404).json({ error: "Portfolio item not found" });
      }
      if (item.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      const updated = await prisma.portfolioItem.update({
        where: { id: itemId },
        data: {
          ...(title !== undefined && { title }),
          ...(description !== undefined && { description }),
        },
      });

      res.json({ ...updated, sizeFormatted: formatFileSize(updated.size) });
    } catch (error) {
      logger.error({ err: error }, "Error updating portfolio item:");
      res.status(500).json({ error: "Failed to update portfolio item" });
    }
  },
);

/**
 * DELETE /api/portfolio/:id
 * Delete a portfolio item
 */
router.delete(
  "/:id",
  authenticate,
  async (req: AuthRequest, res: Response) => {
    try {
      const itemId = req.params.id as string;

      const item = await prisma.portfolioItem.findUnique({ where: { id: itemId } });
      if (!item) {
        return res.status(404).json({ error: "Portfolio item not found" });
      }
      if (item.userId !== req.userId) {
        return res.status(403).json({ error: "Access denied" });
      }

      // Delete file from filesystem
      const filename = item.fileUrl.replace("/api/portfolio/files/", "");
      const filePath = path.join(PORTFOLIO_UPLOAD_DIR, filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }

      await prisma.portfolioItem.delete({ where: { id: itemId } });

      res.json({ message: "Portfolio item deleted successfully" });
    } catch (error) {
      logger.error({ err: error }, "Error deleting portfolio item:");
      res.status(500).json({ error: "Failed to delete portfolio item" });
    }
  },
);

export default router;
