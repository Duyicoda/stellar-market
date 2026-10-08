import { EventEmitter } from "events";
import type { DisputeEvent } from "@prisma/client";

class DisputeEventEmitter extends EventEmitter {
  emitDisputeEvent(disputeId: string, event: DisputeEvent): boolean {
    return this.emit(`dispute:${disputeId}`, event);
  }
}

export const disputeEmitter = new DisputeEventEmitter();
