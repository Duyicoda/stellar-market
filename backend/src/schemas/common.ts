import { z } from "zod";

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().min(1).max(100).default(10),
});

export const idParamSchema = z.object({
  id: z.string().min(1, "ID is required"),
});

export const objectIdSchema = z.string().min(1, "ID is required");

export const emailSchema = z.string().email("Invalid email address");

export const passwordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters long")
  .max(128, "Password must be at most 128 characters long")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number");

export const stellarAddressSchema = z
  .string()
  .min(1, "Stellar address is required")
  .regex(/^G[A-Z0-9]{55}$/, "Invalid Stellar address format");

export const optionalStellarAddressSchema = stellarAddressSchema
  .optional()
  .nullable();

export const statusSchema = z.enum([
  "PENDING",
  "ACTIVE",
  "COMPLETED",
  "CANCELLED",
  "REJECTED",
]);

export const jobStatusSchema = z.enum([
  "OPEN",
  "IN_PROGRESS",
  "COMPLETED",
  "CANCELLED",
]);

export const applicationStatusSchema = z.enum([
  "PENDING",
  "ACCEPTED",
  "REJECTED",
]);

export const milestoneStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "SUBMITTED",
  "APPROVED",
  "REJECTED",
]);

export const reviewRatingSchema = z.number().int().min(1).max(5);
