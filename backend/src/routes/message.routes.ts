import { Router, Response } from "express";
import { PrismaClient, NotificationType } from "@prisma/client";
import { authenticate, AuthRequest } from "../middleware/auth";
import { validate } from "../middleware/validation";
import { asyncHandler } from "../middleware/error";
import { NotificationService } from "../services/notification.service";
import { logger } from "../lib/logger";
import {
  MessageValidationError,
  validateMessageSendAuthorization,
} from "../utils/messageValidation";
import {
  createMessageSchema,
  updateMessageSchema,
  getMessagesQuerySchema,
  getMessageByIdParamSchema,
  markMessageAsReadSchema,
  paginationSchema,
} from "../schemas";

import { buildConversationSummaries } from "../utils/conversations";

const router = Router();
/**
 * @swagger
 * tags:
 *   name: Messages
 *   description: Messaging endpoints
 */
const prisma = new PrismaClient();

// Send a message
router.post(
  /**
   * @swagger
   * /messages:
   *   post:
   *     summary: Send a message
   *     tags: [Messages]
   *     security:
   *       - bearerAuth: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             $ref: '#/components/schemas/CreateMessageRequest'
   *           examples:
   *             example:
   *               value:
   *                 receiverId: "uuid"
   *                 jobId: "uuid"
   *                 content: "Hello!"
   *     responses:
   *       201:
   *         description: Message sent
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/MessageResponse'
   */
  /**
   * @swagger
   * /messages:
   *   get:
   *     summary: Get messages
   *     tags: [Messages]
   *     security:
   *       - bearerAuth: []
   *     responses:
   *       200:
   *         description: List of messages
   *         content:
   *           application/json:
   *             schema:
   *               $ref: '#/components/schemas/MessagesResponse'
   */
  "/",
  authenticate,
  validate({ body: createMessageSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { receiverId, jobId, content } = req.body;

    try {
      await validateMessageSendAuthorization({
        senderId: req.userId!,
        receiverId,
        jobId,
        prismaClient: prisma,
      });
    } catch (error) {
      if (error instanceof MessageValidationError) {
        return res.status(error.status).json({ error: error.message });
      }
      throw error;
    }

    const message = await prisma.message.create({
      data: {
        senderId: req.userId!,
        receiverId,
        jobId: jobId || null,
        content,
      },
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true } },
        receiver: { select: { id: true, username: true, avatarUrl: true } },
      },
    });

    // Notify the receiver
    await NotificationService.sendNotification({
      userId: receiverId,
      type: NotificationType.NEW_MESSAGE,
      title: "New Message",
      message: `You received a new message from ${message.sender.username}`,
      metadata: { messageId: message.id, jobId: message.jobId },
    });

    res.status(201).json(message);
  }),
);


// Get list of conversations for the current user (distinct partners) — used by Socket-based chat UI
router.get(
  "/conversations",
  authenticate,
  validate({ query: paginationSchema }),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId!;
      const page = Number(req.query.page) || 1;
      const limit = Number(req.query.limit) || 10;
      const skip = (page - 1) * limit;

      const messages = await prisma.message.findMany({
        where: {
          OR: [{ senderId: userId }, { receiverId: userId }],
        },
        include: {
          sender: { select: { id: true, username: true, avatarUrl: true } },
          receiver: { select: { id: true, username: true, avatarUrl: true } },
        },
        orderBy: { createdAt: "desc" },
      });

      // Grouped by partner only: one entry per user, merged across jobs.
      const allConversations = buildConversationSummaries(messages, userId, {
        groupBy: "partner",
      }).map(({ otherUser, lastMessage, unreadCount }) => ({
        partner: otherUser,
        lastMessage,
        unreadCount,
      }));
      const total = allConversations.length;
      const conversations = allConversations.slice(skip, skip + limit);
      const hasNext = skip + limit < total;

      res.json({
        data: conversations,
        pagination: {
          page,
          limit,
          total,
          hasNext,
        },
      });
    } catch (error) {
      logger.error({ err: error }, "Conversations error");
      res.status(500).json({ error: "Internal server error." });
    }
  }
);

// Get conversation list OR conversation history (if jobId and participantId are provided)
router.get("/",
  authenticate,
  validate({ query: getMessagesQuerySchema.merge(paginationSchema) }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const jobId = req.query.jobId as string | undefined;
    const senderId = req.query.senderId as string | undefined;
    const receiverId = req.query.receiverId as string | undefined;
    const participantId = req.query.participantId as string | undefined;
    const messageFilters = [
      ...(senderId ? [{ senderId }] : []),
      ...(receiverId ? [{ receiverId }] : []),
    ];
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    if (participantId) {
      const where = {
        AND: [
          jobId ? { jobId: jobId as string } : {},
          {
            OR: [
              { senderId: req.userId!, receiverId: participantId as string },
              { senderId: participantId as string, receiverId: req.userId! },
            ],
          },
          ...messageFilters,
        ],
      };

      const [messages, total] = await Promise.all([
        prisma.message.findMany({
          where,
          include: {
            sender: { select: { id: true, username: true, avatarUrl: true } },
          },
          orderBy: { createdAt: "asc" },
          skip,
          take: limit,
        }),
        prisma.message.count({ where }),
      ]);

      const hasNext = skip + limit < total;

      res.json({
        data: messages,
        pagination: {
          page,
          limit,
          total,
          hasNext,
        },
      });
      return;
    }

    // Fetch all messages involving the user to construct conversation list
    const userMessagesWhere = {
      OR: [{ senderId: req.userId! }, { receiverId: req.userId! }],
    };
    const where =
      messageFilters.length > 0
        ? { AND: [userMessagesWhere, ...messageFilters] }
        : userMessagesWhere;
    const allMessages = await prisma.message.findMany({
      where,
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true } },
        receiver: { select: { id: true, username: true, avatarUrl: true } },
        job: { select: { id: true, title: true } },
      },
      orderBy: { createdAt: "desc" },
    });

    // Grouped by partner AND job: the same partner appears once per job
    // (plus once for job-less messages), so the UI can show per-job threads.
    const allConversations = buildConversationSummaries(allMessages, req.userId!, {
      groupBy: "partner-and-job",
    });
    const total = allConversations.length;
    const conversations = allConversations.slice(skip, skip + limit);
    const hasNext = skip + limit < total;

    res.json({
      data: conversations,
      pagination: {
        page,
        limit,
        total,
        hasNext,
      },
    });
  })
);

// Get total unread message count
router.get(
  "/unread-count",
  authenticate,
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const count = await prisma.message.count({
      where: {
        receiverId: req.userId!,
        read: false,
      },
    });
    res.json({ count });
  }),
);

// Get conversation with a specific user (legacy/direct)
router.get(
  "/:id",
  authenticate,
  validate({
    params: getMessageByIdParamSchema,
    query: getMessagesQuerySchema.pick({ jobId: true }).merge(paginationSchema)
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const otherUserId = req.params.id as string;
    const jobId = req.query.jobId as string | undefined;
    const page = Number(req.query.page) || 1;
    const limit = Number(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const where = {
      AND: [
        jobId ? { jobId: jobId as string } : {},
        {
          OR: [
            { senderId: req.userId!, receiverId: otherUserId },
            { senderId: otherUserId, receiverId: req.userId! },
          ],
        },
      ],
    };

    const [messages, total] = await Promise.all([
      prisma.message.findMany({
        where,
        include: {
          sender: { select: { id: true, username: true, avatarUrl: true } },
        },
        orderBy: { createdAt: "asc" },
        skip,
        take: limit,
      }),
      prisma.message.count({ where }),
    ]);

    // Mark messages as read
    await prisma.message.updateMany({
      where: {
        senderId: otherUserId,
        receiverId: req.userId!,
        jobId: jobId ? (jobId as string) : undefined,
        read: false,
      },
      data: { read: true },
    });

    const hasNext = skip + limit < total;

    res.json({
      data: messages,
      pagination: {
        page,
        limit,
        total,
        hasNext,
      },
    });
  }),
);

// Mark a specific message as read
router.put(
  "/:id/read",
  authenticate,
  validate({
    params: getMessageByIdParamSchema,
    body: markMessageAsReadSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const { isRead } = req.body;

    const message = await prisma.message.findUnique({
      where: { id },
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found." });
    }
    if (message.receiverId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to mark this message as read." });
    }

    await prisma.message.update({
      where: { id },
      data: { read: isRead },
    });
    res.status(204).send();
  }),
);

// Update a message
router.put(
  "/:id",
  authenticate,
  validate({
    params: getMessageByIdParamSchema,
    body: updateMessageSchema,
  }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;
    const { content } = req.body;

    const message = await prisma.message.findUnique({
      where: { id },
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found." });
    }
    if (message.senderId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to update this message." });
    }

    const updated = await prisma.message.update({
      where: { id },
      data: { content },
      include: {
        sender: { select: { id: true, username: true, avatarUrl: true } },
        receiver: { select: { id: true, username: true, avatarUrl: true } },
      },
    });

    res.json(updated);
  }),
);

// Delete a message
router.delete(
  "/:id",
  authenticate,
  validate({ params: getMessageByIdParamSchema }),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const id = req.params.id as string;

    const message = await prisma.message.findUnique({
      where: { id },
    });

    if (!message) {
      return res.status(404).json({ error: "Message not found." });
    }
    if (message.senderId !== req.userId) {
      return res
        .status(403)
        .json({ error: "Not authorized to delete this message." });
    }

    await prisma.message.delete({ where: { id } });
    res.json({ message: "Message deleted successfully." });
  }),
);

export default router;
