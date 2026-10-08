import { z } from "zod";
import { paginationSchema, applicationStatusSchema } from "./common";

export const createApplicationSchema = z.object({
  jobId: z.string().min(1, "Job ID is required"),
  proposal: z
    .string()
    .min(20, "Cover letter must be at least 20 characters long")
    .max(2000, "Cover letter must be less than 2000 characters"),
  estimatedDuration: z
    .number()
    .int()
    .positive("Estimated duration must be a positive integer in days"),
  bidAmount: z.number().positive("Bid amount must be a positive number"),
});

export const updateApplicationSchema = z.object({
  proposal: z
    .string()
    .min(20, "Cover letter must be at least 20 characters long")
    .max(2000, "Cover letter must be less than 2000 characters")
    .optional(),
  estimatedDuration: z
    .number()
    .int()
    .positive("Estimated duration must be a positive integer in days")
    .optional(),
  bidAmount: z
    .number()
    .positive("Bid amount must be a positive number")
    .optional(),
});

export const updateApplicationStatusSchema = z.object({
  status: applicationStatusSchema,
});

export const getApplicationsQuerySchema = paginationSchema.extend({
  jobId: z.string().min(1).optional(),
  freelancerId: z.string().min(1).optional(),
  status: applicationStatusSchema.optional(),
});

export const getApplicationByIdParamSchema = z.object({
  id: z.string().cuid("Invalid id format"),
});
