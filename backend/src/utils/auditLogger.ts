import { AuditService } from "../services/audit.service";

/**
 * Audit logging entry points.
 *
 * Both helpers below are thin, backward-compatible wrappers over the single
 * unified, hash-chained audit trail (see services/audit.service.ts, issue #875).
 * Their signatures are unchanged so every existing call site keeps working; the
 * difference is that entries are now durably queued and guaranteed to be
 * persisted (via the outbox worker) rather than written best-effort — or, in the
 * security-event case, not persisted at all.
 */

/**
 * Log an administrative action (suspend user, delete job, override dispute, …).
 *
 * @param adminId - The ID of the admin performing the action
 * @param action - The name of the action (e.g., "SUSPEND_USER")
 * @param target - The ID or identifier of the target entity
 * @param metadata - Optional additional JSON metadata about the action
 */
export const logAdminAction = async (
  adminId: string,
  action: string,
  target: string,
  metadata?: unknown,
): Promise<void> => {
  await AuditService.record({
    category: "ADMIN_ACTION",
    action,
    actorId: adminId,
    target,
    metadata,
  });
};

/**
 * Generic audit logger for security-relevant system events (virus scanning,
 * blocked uploads, etc.). Previously this only logged to pino and never
 * persisted; it now goes through the same durable, hash-chained mechanism.
 */
interface AuditLogEntry {
  action: string;
  userId: string;
  details: unknown;
  ipAddress: string;
}

export const auditLogger = {
  log: (entry: AuditLogEntry): void => {
    // Fire-and-forget: enqueue is non-blocking and never throws for a DB issue,
    // so security-event call sites (which do not await) stay unaffected.
    void AuditService.record({
      category: "SECURITY_EVENT",
      action: entry.action,
      actorId: entry.userId,
      metadata: entry.details,
      ipAddress: entry.ipAddress,
    });
  },
};
