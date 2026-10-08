import { z } from "zod";
import { paginationSchema } from "./common";

export const flagJobSchema = z.object({
  flagReason: z
    .string()
    .min(1, "Flag reason is required")
    .max(500, "Flag reason must be less than 500 characters"),
});

export const suspendUserSchema = z.object({
  suspendReason: z
    .string()
    .min(1, "Suspension reason is required")
    .max(500, "Suspension reason must be less than 500 characters"),
});

export const getUsersAdminQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  role: z.enum(["CLIENT", "FREELANCER", "ADMIN"]).optional(),
  isSuspended: z
    .string()
    .transform((val) => val === "true")
    .optional(),
  isVerified: z
    .string()
    .transform((val) => val === "true")
    .optional(),
});

export const getJobsAdminQuerySchema = paginationSchema.extend({
  limit: z.coerce.number().int().positive().min(1).max(100).default(20),
  includeDeleted: z
    .string()
    .transform((val) => val === "true")
    .optional(),
});

export const overrideDisputeSchema = z.object({
  outcome: z
    .string()
    .min(1, "Outcome is required")
    .max(500, "Outcome must be less than 500 characters"),
  status: z.enum([
    "RESOLVED_FOR_CLIENT",
    "RESOLVED_FOR_FREELANCER",
    "OVERRIDDEN_BY_ADMIN",
  ]),
});

export const getAuditLogsQuerySchema = paginationSchema.extend({
  category: z.enum(["ADMIN_ACTION", "SECURITY_EVENT"]).optional(),
  action: z.string().min(1).optional(),
  actorId: z.string().min(1).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  format: z.enum(["json", "csv"]).optional(),
});

export const queryAdminDisputesSchema = paginationSchema;

export const queryPendingDisputesSchema = paginationSchema;

export const queryFlaggedUsersSchema = paginationSchema;

export const getReportsAdminQuerySchema = paginationSchema.extend({
  status: z.enum(["PENDING", "REVIEWED", "DISMISSED"]).optional(),
  targetType: z.enum(["JOB", "USER", "MESSAGE"]).optional(),
});

export const updateReportSchema = z.object({
  status: z.enum(["PENDING", "REVIEWED", "DISMISSED"]),
  suspend: z.boolean().optional(),
  suspendReason: z
    .string()
    .max(500, "Suspension reason must be less than 500 characters")
    .optional(),
});

export const patchSuspendUserSchema = z.object({
  suspendReason: z
    .string()
    .max(500, "Suspension reason must be less than 500 characters")
    .optional(),
  isSuspended: z.boolean(),
});

export type FlagJobInput = z.infer<typeof flagJobSchema>;
export type SuspendUserInput = z.infer<typeof suspendUserSchema>;
export type GetUsersAdminQuery = z.infer<typeof getUsersAdminQuerySchema>;
export type GetJobsAdminQuery = z.infer<typeof getJobsAdminQuerySchema>;
export type OverrideDisputeInput = z.infer<typeof overrideDisputeSchema>;
export type QueryAdminDisputes = z.infer<typeof queryAdminDisputesSchema>;
export type QueryPendingDisputes = z.infer<typeof queryPendingDisputesSchema>;
export type QueryFlaggedUsers = z.infer<typeof queryFlaggedUsersSchema>;
export type UpdateReportInput = z.infer<typeof updateReportSchema>;
export type PatchSuspendUserInput = z.infer<typeof patchSuspendUserSchema>;
