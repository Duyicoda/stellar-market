import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { PrismaClient } from "@prisma/client";
import jwt from "jsonwebtoken";
import { config } from "../config";
import { registerMessageHandlers } from "./messageHandlers";
import { logger } from "../lib/logger";
import { startNotificationWorker } from "../lib/notification-queue";
import RedisClient from "../lib/redis";
import { getCurrentTokenVersion } from "../lib/token-version";
import { getCachedUserAuthData } from "../lib/user-cache";
import {
  isUserOnline as isUserOnlineInRegistry,
  markSocketOnline,
  markSocketOffline,
  startPresenceHeartbeat,
} from "../lib/presence";

const prisma = new PrismaClient();

export interface AuthenticatedSocket extends Socket {
  data: {
    userId: string;
  };
}

let io: SocketServer;

export function isUserOnline(userId: string): Promise<boolean> {
  return isUserOnlineInRegistry(userId);
}

export function emitToUser(userId: string, event: string, data: unknown): void {
  io?.to(`user:${userId}`).emit(event, data);
}

async function deliverPendingNotifications(socket: AuthenticatedSocket, userId: string) {
  try {
    const pending = await prisma.pendingNotification.findMany({
      where: { userId, deliveredAt: null },
      include: { notification: true },
      orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    });

    for (const p of pending) {
      socket.emit("notification:new", p.notification);
      await prisma.pendingNotification.update({
        where: { id: p.id },
        data: { deliveredAt: new Date() },
      });
    }

    if (pending.length > 0) {
      logger.info({ userId, count: pending.length }, "Delivered pending notifications on reconnect");
    }
  } catch (err) {
    logger.error({ err, userId }, "Error delivering pending notifications");
  }
}

export function initSocket(httpServer: HttpServer): SocketServer {
  const pubClient = RedisClient.getInstance();
  const subClient = pubClient.duplicate();

  io = new SocketServer(httpServer, {
    cors: {
      origin: config.frontendUrl,
      methods: ["GET", "POST"],
      credentials: true,
    },
    adapter: createAdapter(pubClient, subClient),
  });

  // JWT auth middleware — runs before every connection
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;

    if (!token) {
      return next(new Error("Authentication error: No token provided."));
    }

    try {
      const decoded = jwt.verify(token, config.jwtSecret) as {
        userId: string;
        purpose?: string;
        tokenVersion?: number;
      };

      // Reject 2FA-pending tokens (same as HTTP authenticate)
      if (decoded.purpose === "2fa_pending") {
        return next(new Error("Authentication error: 2FA verification required."));
      }

      // Reject tokens invalidated by a password change
      const currentTokenVersion = await getCurrentTokenVersion(decoded.userId);
      if (
        currentTokenVersion !== null &&
        (decoded.tokenVersion ?? 0) !== currentTokenVersion
      ) {
        return next(new Error("Authentication error: Token has been invalidated. Please log in again."));
      }

      // Verify user exists and is not deleted/suspended
      const user = await getCachedUserAuthData(decoded.userId);
      if (!user) {
        return next(new Error("Authentication error: User not found."));
      }
      if (user.deletedAt) {
        return next(new Error("Authentication error: Account deleted."));
      }
      if (user.isSuspended) {
        return next(new Error("Authentication error: Account suspended."));
      }

      (socket as AuthenticatedSocket).data.userId = decoded.userId;
      next();
    } catch {
      next(new Error("Authentication error: Invalid or expired token."));
    }
  });

  io.on("connection", (socket) => {
    const authedSocket = socket as AuthenticatedSocket;
    const userId = authedSocket.data.userId;
    const joinedRooms = new Set<string>();

    void markSocketOnline(userId, socket.id).catch((err) => {
      logger.error({ err, userId, socketId: socket.id }, "Failed to record presence on connect");
    });
    const heartbeat = startPresenceHeartbeat(userId, socket.id);

    socket.join(`user:${userId}`);
    joinedRooms.add(`user:${userId}`);
    logger.info({ userId, socketId: socket.id }, "Socket connected");

    void deliverPendingNotifications(authedSocket, userId);

    registerMessageHandlers(io, authedSocket);

    socket.on("disconnect", () => {
      clearInterval(heartbeat);
      void markSocketOffline(userId, socket.id).catch((err) => {
        logger.error({ err, userId, socketId: socket.id }, "Failed to clear presence on disconnect");
      });
      for (const room of joinedRooms) {
        socket.leave(room);
      }
      logger.info({ userId, socketId: socket.id }, "Socket disconnected");
    });
  });

  startNotificationWorker(isUserOnline, emitToUser);

  return io;
}

export function getIo(): SocketServer {
  if (!io) {
    throw new Error("Socket.io not initialized!");
  }
  return io;
}
