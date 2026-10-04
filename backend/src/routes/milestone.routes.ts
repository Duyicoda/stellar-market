import { Router, Response } from "express";
import { PrismaClient, Prisma } from "@prisma/client";
import fs from "fs";
import path from "path";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import { NotificationService } from "../services/notification.service";
import { NotificationType } from "@prisma/client";
import { ContractService } from "../services/contract.service";
import { upload, UPLOAD_DIR } from "../config/upload";
import { validateFileMimeType, formatFileSize } from "../utils/fileValidation";
import { z } from "zod";
import {
  createMilestoneSchema,
  updateMilestoneSchema,
  updateMilestoneStatusSchema,
  getMilestonesQuerySchema,
  getMilestoneByIdParamSchema,
  getJobByIdParamSchema,
} from "../schemas";

const router = Router();
const prisma = new PrismaClient();

// Valid status transitions per role
const freelancerTransitions: Record<string, string[]> = {
  PENDING: ["IN_PROGRESS"],
  IN_PROGRESS: ["SUBMITTED"],
};

const clientTransitions: Record<string, string[]> = {
  // Approval is chain-owned and can only be projected by the verified
  // escrow confirmation path; clients may only reject a submission here.
  SUBMITTED: ["REJECTED"],
};

// List milestones for a job
router.get(
  "/jobs/:jobId/milestones",
  authenticate,
  validate({ params: getJobByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const jobId = req.params.jobId as string;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }

    const isClient = job.clientId === req.userId;
    const isFreelancer = job.freelancerId === req.userId;

    if (!isClient && !isFreelancer) {
      return res
        .status(403)
        .json({ error: "Not authorized to view milestones for this job." });
    }

    const milestones = await prisma.milestone.findMany({
      where: { jobId },
      orderBy: { createdAt: "asc" },
    });

    res.json(milestones);
  }),
);

// Get all milestones with filtering
router.get(
  "/",
  authenticate,
  validate({ query: getMilestonesQuerySchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { page, limit, jobId, status } = req.query as unknown as z.infer<
      typeof getMilestonesQuerySchema
    >;
    const skip = (page - 1) * limit;

    // If a specific jobId is requested, verify the caller is a party to that job
    // before returning any results for it.
    if (jobId) {
      const job = await prisma.job.findUnique({ where: { id: jobId } });
      if (!job) {
        return res.status(404).json({ error: "Job not found." });
      }
      const isParty =
        job.clientId === req.userId || job.freelancerId === req.userId;
      if (!isParty) {
        return res
          .status(403)
          .json({ error: "Not authorized to view milestones for this job." });
      }
    }

    // Always scope results to milestones belonging to jobs the caller is a
    // client or freelancer on — preventing cross-user data leaks.
    const where: Prisma.MilestoneWhereInput = {
      job: {
        OR: [{ clientId: req.userId }, { freelancerId: req.userId }],
      },
    };
    if (jobId) where.jobId = jobId;
    if (status) where.status = status;

    const [milestones, total] = await Promise.all([
      prisma.milestone.findMany({
        where,
        include: {
          job: { select: { id: true, title: true } },
        },
        orderBy: { createdAt: "desc" },
        skip,
        take: limit,
      }),
      prisma.milestone.count({ where }),
    ]);

    res.json({
      data: milestones,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    });
  }),
);

// Create a new milestone
router.post(
  "/",
  authenticate,
  validate({ body: createMilestoneSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { jobId, title, description, amount, dueDate } = req.body;

    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job) {
      return res.status(404).json({ error: "Job not found." });
    }
    if (job.clientId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to create milestones for this job." });
    }

    const existingMilestones = await prisma.milestone.findMany({
      where: { jobId },
      select: { amount: true },
    });
    const currentTotal = existingMilestones.reduce(
      (sum, m) => sum + m.amount,
      0,
    );

    if (
      job.budget != null &&
      Number((currentTotal + amount).toFixed(7)) > Number(job.budget.toFixed(7))
    ) {
      return res
        .status(400)
        .json({ error: "Total milestone amount exceeds job budget." });
    }

    const milestone = await prisma.milestone.create({
      data: {
        jobId,
        title,
        description,
        amount,
        dueDate: new Date(dueDate),
        order: existingMilestones.length + 1,
      },
      include: {
        job: { select: { id: true, title: true } },
      },
    });

    res.status(201).json(milestone);
  }),
);

// Get a single milestone by ID
router.get(
  "/:id",
  authenticate,
  validate({ params: getMilestoneByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: {
        job: {
          select: {
            id: true,
            title: true,
            clientId: true,
            freelancerId: true,
          },
        },
      },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }

    // Check if user is authorized to view this milestone
    const isClient = milestone.job.clientId === req.userId;
    const isFreelancer = milestone.job.freelancerId === req.userId;

    if (!isClient && !isFreelancer) {
      return res
        .status(403)
        .json({ error: "Not authorized to view this milestone." });
    }

    res.json(milestone);
  }),
);

// Update a milestone
router.put(
  "/:id",
  authenticate,
  validate({
    params: getMilestoneByIdParamSchema,
    body: updateMilestoneSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const updateData = req.body;

    if (updateData.dueDate) {
      updateData.dueDate = new Date(updateData.dueDate);
    }

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }
    if (milestone.job.clientId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this milestone." });
    }

    if (updateData.amount != null) {
      const siblings = await prisma.milestone.findMany({
        where: { jobId: milestone.jobId, NOT: { id } },
        select: { amount: true },
      });
      const otherTotal = siblings.reduce((s, m) => s + m.amount, 0);
      if (milestone.job.budget != null && Number((otherTotal + updateData.amount).toFixed(7)) > Number(milestone.job.budget.toFixed(7))) {
        return res.status(400).json({ error: "Total milestone amount exceeds job budget." });
      }
    }

    const updated = await prisma.milestone.update({
      where: { id },
      data: updateData,
      include: {
        job: { select: { id: true, title: true } },
      },
    });

    res.json(updated);
  }),
);

// Delete a milestone
router.delete(
  "/:id",
  authenticate,
  validate({ params: getMilestoneByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }
    if (milestone.job.clientId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this milestone." });
    }

    await prisma.milestone.delete({ where: { id } });
    res.json({ message: "Milestone deleted successfully." });
  }),
);

// Update milestone status
router.patch(
  "/:id/status",
  authenticate,
  validate({
    params: getMilestoneByIdParamSchema,
    body: updateMilestoneStatusSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const { status } = req.body;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: true },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }

    const job = milestone.job;
    const isClient = job.clientId === req.userId;
    const isFreelancer = job.freelancerId === req.userId;

    if (!isClient && !isFreelancer) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this milestone." });
    }

    // Determine allowed transitions based on role
    const currentStatus = milestone.status;
    const allowedStatuses = isFreelancer
      ? (freelancerTransitions[currentStatus] || [])
      : (clientTransitions[currentStatus] || []);

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        error: `Invalid status transition from ${currentStatus} to ${status} for ${isFreelancer ? 'Freelancer' : 'Client'}.`
      });
    }

    const updated = await prisma.milestone.update({
      where: { id },
      data: { status },
    });

    // Emit Socket.IO event for real-time updates
    const { getIo } = await import("../socket");
    const io = getIo();
    io.to(`job:${updated.jobId}`).emit("milestone:status_changed", {
      milestoneId: updated.id,
      jobId: updated.jobId,
      status: updated.status,
      updatedAt: new Date(),
    });

    // Notify the client when freelancer submits milestone
    if (isFreelancer && status === "SUBMITTED") {
      await NotificationService.sendNotification({
        userId: job.clientId,
        type: NotificationType.MILESTONE_SUBMITTED,
        title: "Milestone Submitted",
        message: `Freelancer submitted milestone: ${milestone.title}`,
        metadata: { jobId: job.id, milestoneId: id },
      });
    }

    // Notify the freelancer when client rejects milestone
    if (!isFreelancer && status === "REJECTED") {
      await NotificationService.sendNotification({
        userId: job.freelancerId as string,
        type: NotificationType.MILESTONE_REJECTED,
        title: "Milestone Rejected",
        message: `Client rejected milestone: ${milestone.title}`,
        metadata: { jobId: job.id, milestoneId: id },
      });
    }

    res.json(updated);
  }),
);

// Submit milestone (returns XDR for freelancer signing)
router.put(
  "/milestones/:id/submit",
  authenticate,
  validate({ params: getMilestoneByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: { include: { freelancer: true } } },
    });

    if (!milestone || !milestone.job.contractJobId || milestone.onChainIndex === null) {
      return res.status(404).json({ error: "On-chain milestone not found." });
    }

    if (!milestone.job.freelancer || milestone.job.freelancerId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Only the assigned freelancer can submit milestones." });
    }

    if (milestone.status !== "IN_PROGRESS") {
      return res.status(400).json({ error: "Milestone must be in progress to submit." });
    }

    if (!milestone.job.freelancer.walletAddress) {
      return res.status(400).json({ error: "Connect a wallet address before submitting this milestone." });
    }

    const xdr = await ContractService.buildSubmitMilestoneTx(
      milestone.job.freelancer.walletAddress ?? "",
      milestone.job.contractJobId ?? "",
      milestone.onChainIndex,
    );

    res.json({ xdr });
  }),
);

// ─── Deliverable attachments ──────────────────────────────────────────────────

const deliverableParamSchema = z.object({ id: z.string() });
const deliverableDeleteParamSchema = z.object({
  id: z.string(),
  attachmentId: z.string(),
});

/**
 * POST /api/milestones/:id/deliverables
 * Upload a file deliverable for a milestone.
 * Only the assigned freelancer may upload; milestone must not be APPROVED.
 */
router.post(
  "/:id/deliverables",
  authenticate,
  upload.single("file"),
  validate({ params: deliverableParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded." });
    }

    const milestoneId = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: { job: { select: { id: true, clientId: true, freelancerId: true, title: true } } },
    });

    if (!milestone) {
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: "Milestone not found." });
    }

    const job = milestone.job;

    if (job.freelancerId !== req.userId) {
      fs.unlinkSync(req.file.path);
      return res.status(403).json({ error: "Only the assigned freelancer can upload deliverables." });
    }

    if (milestone.status === "APPROVED") {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Cannot add deliverables to an already approved milestone." });
    }

    // MIME sniffing validation
    const validation = await validateFileMimeType(req.file.path);
    if (!validation.valid) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: validation.error || "Invalid file type." });
    }

    const attachment = await prisma.attachment.create({
      data: {
        uploaderId: req.userId!,
        jobId: job.id,
        milestoneId,
        filename: req.file.filename,
        originalName: req.file.originalname,
        mimeType: validation.detectedType || req.file.mimetype,
        size: req.file.size,
        url: `/api/uploads/${req.file.filename}`,
      },
      include: {
        uploader: { select: { id: true, username: true, walletAddress: true } },
      },
    });

    // Notify the client that a deliverable was attached
    await NotificationService.sendNotification({
      userId: job.clientId,
      type: NotificationType.MILESTONE_SUBMITTED,
      title: "Deliverable Uploaded",
      message: `A file deliverable was attached to milestone "${milestone.title}" on job "${job.title}".`,
      metadata: { jobId: job.id, milestoneId, attachmentId: attachment.id },
    });

    res.status(201).json({ ...attachment, sizeFormatted: formatFileSize(attachment.size) });
  }),
);

/**
 * GET /api/milestones/:id/deliverables
 * List all file deliverables for a milestone.
 * Accessible by both the client and the freelancer of the job.
 */
router.get(
  "/:id/deliverables",
  authenticate,
  validate({ params: deliverableParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const milestoneId = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id: milestoneId },
      include: { job: { select: { clientId: true, freelancerId: true } } },
    });

    if (!milestone) {
      return res.status(404).json({ error: "Milestone not found." });
    }

    const job = milestone.job;
    if (job.clientId !== req.userId && job.freelancerId !== req.userId) {
      return res.status(403).json({ error: "Access denied." });
    }

    const attachments = await prisma.attachment.findMany({
      where: { milestoneId },
      include: {
        uploader: { select: { id: true, username: true, walletAddress: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    res.json({
      attachments: attachments.map((a) => ({
        ...a,
        sizeFormatted: formatFileSize(a.size),
      })),
    });
  }),
);

/**
 * DELETE /api/milestones/:id/deliverables/:attachmentId
 * Delete a deliverable.  Only the uploader may delete, and only while the
 * milestone is not yet APPROVED.
 */
router.delete(
  "/:id/deliverables/:attachmentId",
  authenticate,
  validate({ params: deliverableDeleteParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const milestoneId = req.params.id as string;
    const attachmentId = req.params.attachmentId as string;

    const attachment = await prisma.attachment.findUnique({
      where: { id: attachmentId },
      include: { milestone: { select: { id: true, status: true } } },
    });

    if (!attachment || attachment.milestoneId !== milestoneId) {
      return res.status(404).json({ error: "Deliverable not found." });
    }

    if (attachment.uploaderId !== req.userId) {
      return res.status(403).json({ error: "Only the uploader can delete this deliverable." });
    }

    if (attachment.milestone?.status === "APPROVED") {
      return res.status(400).json({ error: "Cannot delete a deliverable from an approved milestone." });
    }

    const filePath = path.join(UPLOAD_DIR, attachment.filename);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    await prisma.attachment.delete({ where: { id: attachmentId } });

    res.json({ message: "Deliverable deleted successfully." });
  }),
);

// Approve milestone (returns XDR for client signing)
router.put(
  "/milestones/:id/approve",
  authenticate,
  validate({ params: getMilestoneByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const milestone = await prisma.milestone.findUnique({
      where: { id },
      include: { job: { include: { client: true } } },
    });

    if (!milestone || !milestone.job.contractJobId || milestone.onChainIndex === null) {
      return res.status(404).json({ error: "On-chain milestone not found." });
    }

    if (milestone.job.clientId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Only the client can approve milestones." });
    }

    if (milestone.status !== "SUBMITTED") {
      return res.status(400).json({ error: "Milestone must be submitted to approve." });
    }

    if (!milestone.job.client.walletAddress) {
      return res.status(400).json({ error: "Connect a wallet address before approving this milestone." });
    }

    const xdr = await ContractService.buildApproveMilestoneTx(
      milestone.job.client.walletAddress ?? "",
      milestone.job.contractJobId ?? "",
      milestone.onChainIndex,
    );

    res.json({ xdr });
  }),
);

export default router;
