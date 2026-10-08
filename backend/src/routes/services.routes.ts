import { Router, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import { z } from "zod";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import {
  createServiceSchema,
  updateServiceSchema,
  getServicesQuerySchema,
  serviceIdParamSchema,
} from "../schemas";

const router = Router();
const prisma = new PrismaClient();

const freelancerSelect = {
  id: true,
  username: true,
  avatarUrl: true,
} as const;

// GET /api/services — public, paginated
router.get(
  "/",
  validate({ query: getServicesQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page, limit, search, category, minPrice, maxPrice, freelancerId } =
      req.query as unknown as z.infer<typeof getServicesQuerySchema>;

    const skip = (page - 1) * limit;

    const where: Prisma.ServiceWhereInput = {};

    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    if (category) {
      where.category = { equals: category, mode: "insensitive" };
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      where.price = {};
      if (minPrice !== undefined) where.price.gte = minPrice;
      if (maxPrice !== undefined) where.price.lte = maxPrice;
    }

    if (freelancerId) {
      where.freelancerId = freelancerId;
    }

    const [services, total] = await Promise.all([
      prisma.service.findMany({
        where,
        include: { freelancer: { select: freelancerSelect } },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.service.count({ where }),
    ]);

    res.json({
      data: services,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  }),
);

// GET /api/services/:id — public
router.get(
  "/:id",
  validate({ params: serviceIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const service = await prisma.service.findUnique({
      where: { id: req.params.id as string },
      include: { freelancer: { select: freelancerSelect } },
    });

    if (!service) {
      return res.status(404).json({ error: "Service not found." });
    }

    res.json(service);
  }),
);

// POST /api/services — freelancer only
router.post(
  "/",
  authenticate,
  validate({ body: createServiceSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const user = await prisma.user.findUnique({
      where: { id: req.userId },
      select: { role: true },
    });

    if (!user || user.role !== "FREELANCER") {
      return res
        .status(403)
        .json({ error: "Only freelancers can create services." });
    }

    const { title, description, category, price, deliveryDays, skills } =
      req.body;

    const service = await prisma.service.create({
      data: {
        title,
        description,
        category,
        price,
        deliveryDays,
        skills: skills ?? [],
        freelancerId: req.userId!,
      },
      include: { freelancer: { select: freelancerSelect } },
    });

    res.status(201).json(service);
  }),
);

// PUT /api/services/:id — owner only
router.put(
  "/:id",
  authenticate,
  validate({ params: serviceIdParamSchema, body: updateServiceSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const service = await prisma.service.findUnique({
      where: { id: req.params.id as string },
    });

    if (!service) {
      return res.status(404).json({ error: "Service not found." });
    }
    if (service.freelancerId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this service." });
    }

    const updated = await prisma.service.update({
      where: { id: req.params.id as string },
      data: req.body,
      include: { freelancer: { select: freelancerSelect } },
    });

    res.json(updated);
  }),
);

// DELETE /api/services/:id — owner only
router.delete(
  "/:id",
  authenticate,
  validate({ params: serviceIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const service = await prisma.service.findUnique({
      where: { id: req.params.id as string },
    });

    if (!service) {
      return res.status(404).json({ error: "Service not found." });
    }
    if (service.freelancerId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this service." });
    }

    await prisma.service.delete({ where: { id: req.params.id as string } });
    res.json({ message: "Service deleted successfully." });
  }),
);

export default router;
