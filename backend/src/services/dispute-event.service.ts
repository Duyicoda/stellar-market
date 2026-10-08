import {
  PrismaClient,
  DisputeEventType,
  type DisputeEvent,
  type Prisma,
} from "@prisma/client";
import { disputeEmitter } from "../lib/dispute-emitter";

const prisma = new PrismaClient();

export async function recordDisputeEvent(
  disputeId: string,
  type: DisputeEventType,
  payload?: Record<string, unknown>,
): Promise<DisputeEvent> {
  const event = await prisma.disputeEvent.create({
    data: {
      disputeId,
      type,
      payload: (payload ?? {}) as Prisma.InputJsonValue,
    },
  });

  disputeEmitter.emitDisputeEvent(disputeId, event);
  return event;
}
