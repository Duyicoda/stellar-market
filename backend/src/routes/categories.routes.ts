import { Router, Request, Response } from "express";
import { JOB_CATEGORIES } from "../constants/categories";

const router = Router();

/**
 * @swagger
 * /categories:
 *   get:
 *     summary: Get all job categories
 *     tags: [Jobs]
 *     responses:
 *       200:
 *         description: List of job categories
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: string
 *             example:
 *               - Frontend
 *               - Backend
 *               - Smart Contract
 *               - Design
 *               - Mobile
 *               - Documentation
 *               - DevOps
 */
router.get("/", (_req: Request, res: Response) => {
  res.json(JOB_CATEGORIES);
});

export default router;
