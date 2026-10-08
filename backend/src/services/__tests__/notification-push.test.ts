import { NotificationService } from "../notification.service";
import webpush from "web-push";
import { config } from "../../config";
import type { NotificationType } from "@prisma/client";

jest.mock("web-push", () => ({
  __esModule: true,
  default: {
    setVapidDetails: jest.fn(),
    sendNotification: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("../../config", () => ({
  config: {
    vapidPublicKey: "",
    vapidPrivateKey: "",
    vapidSubject: "mailto:admin@stellarmarket.io",
  },
}));

jest.mock("../email.service", () => ({
  EmailService: { send: jest.fn().mockResolvedValue(undefined) },
}));

jest.mock("../../socket", () => ({
  getIo: jest.fn().mockReturnValue({
    to: jest.fn().mockReturnValue({ emit: jest.fn() }),
  }),
}));

jest.mock("../../lib/notification-queue", () => ({
  notificationQueue: { add: jest.fn().mockResolvedValue(undefined) },
  getNotificationPriority: jest.fn().mockReturnValue(3),
}));

const mockPushSubscriptionFindMany = jest.fn();
const mockNotificationCreate = jest.fn();

interface MockPrismaClient {
  notification: { create: (...args: unknown[]) => unknown };
  pushSubscription: { findMany: (...args: unknown[]) => unknown; delete: jest.Mock };
  $transaction: jest.Mock;
}

jest.mock("@prisma/client", () => {
  const mockPrisma: MockPrismaClient = {
    notification: {
      create: (...args: unknown[]) => mockNotificationCreate(...args),
    },
    pushSubscription: {
      findMany: (...args: unknown[]) => mockPushSubscriptionFindMany(...args),
      delete: jest.fn(),
    },
    $transaction: jest.fn(async (cb: (client: MockPrismaClient) => unknown) => cb(mockPrisma)),
  };
  return {
    PrismaClient: jest.fn(() => mockPrisma),
    NotificationType: {
      MILESTONE_APPROVED: "MILESTONE_APPROVED",
      NEW_MESSAGE: "NEW_MESSAGE",
    },
  };
});

const webpushMocked = webpush as unknown as {
  setVapidDetails: jest.Mock;
  sendNotification: jest.Mock;
};

const configMock = config as { vapidPublicKey: string; vapidPrivateKey: string };

describe("NotificationService push dispatch", () => {
  const userId = "user-1";
  const subscription = {
    id: "sub-1",
    userId,
    endpoint: "https://push.example.com/abc",
    p256dh: "p256dh-key",
    auth: "auth-key",
  };

  beforeEach(() => {
    jest.clearAllMocks();
    configMock.vapidPublicKey = "";
    configMock.vapidPrivateKey = "";
    mockNotificationCreate.mockResolvedValue({
      id: "notif-1",
      userId,
      type: "MILESTONE_APPROVED",
      title: "Milestone Approved",
      message: "Your milestone was approved",
      metadata: {},
    });
    mockPushSubscriptionFindMany.mockResolvedValue([subscription]);
  });

  it("sends a push notification for a qualifying type when VAPID is configured", async () => {
    configMock.vapidPublicKey = "public-key";
    configMock.vapidPrivateKey = "private-key";

    await NotificationService.sendNotification({
      userId,
      type: "MILESTONE_APPROVED" as NotificationType,
      title: "Milestone Approved",
      message: "Your milestone was approved",
      skipBatching: true,
    });

    expect(mockPushSubscriptionFindMany).toHaveBeenCalledWith({
      where: { userId },
    });
    expect(webpushMocked.sendNotification).toHaveBeenCalledTimes(1);
    expect(webpushMocked.sendNotification).toHaveBeenCalledWith(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      expect.stringContaining("Milestone Approved"),
    );
  });

  it("does not push for notification types outside the push-enabled list", async () => {
    configMock.vapidPublicKey = "public-key";
    configMock.vapidPrivateKey = "private-key";
    mockNotificationCreate.mockResolvedValueOnce({
      id: "notif-2",
      userId,
      type: "NEW_MESSAGE",
      title: "New message",
      message: "hi",
      metadata: {},
    });

    await NotificationService.sendNotification({
      userId,
      type: "SOME_OTHER_TYPE" as NotificationType,
      title: "Other",
      message: "Not push-enabled",
      skipBatching: true,
    });

    expect(webpushMocked.sendNotification).not.toHaveBeenCalled();
  });

  it("skips push gracefully when VAPID keys are not configured", async () => {
    const result = await NotificationService.sendNotification({
      userId,
      type: "MILESTONE_APPROVED" as NotificationType,
      title: "Milestone Approved",
      message: "Your milestone was approved",
      skipBatching: true,
    });

    expect(result).toBeTruthy();
    expect(webpushMocked.sendNotification).not.toHaveBeenCalled();
    expect(mockPushSubscriptionFindMany).not.toHaveBeenCalled();
  });
});
