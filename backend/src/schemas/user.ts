import { z } from "zod";
import {
  emailSchema,
  paginationSchema,
} from "./common";

export const updateUserProfileSchema = z.object({
  name: z
    .string()
    .min(2, "Name must be at least 2 characters long")
    .max(100, "Name must be less than 100 characters")
    .optional(),
  email: emailSchema.optional(),
  bio: z.string().max(500, "Bio must be less than 500 characters").optional(),
  skills: z
    .array(z.string())
    .max(10, "Cannot have more than 10 skills")
    .optional(),
  // walletAddress is intentionally excluded — use POST /auth/wallet/challenge
  // then POST /auth/wallet/verify to prove key ownership before binding.
  availability: z.boolean().optional(),
});

export const getUsersQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  skill: z.string().optional(),
  role: z.enum(["CLIENT", "FREELANCER"]).optional(),
});

export const getUserJobsQuerySchema = paginationSchema;

export const getUserByIdParamSchema = z.object({
  id: z.string().cuid("Invalid id format"),
});

export const updateCurrentUserProfileSchema = z.object({
  username: z
    .string()
    .min(3, "Username must be at least 3 characters")
    .max(30, "Username must be at most 30 characters")
    .regex(
      /^[a-zA-Z0-9_-]+$/,
      "Username can only contain letters, numbers, hyphens, and underscores",
    )
    .optional(),
  email: z.string().email("Invalid email address").optional().nullable(),
  bio: z
    .string()
    .max(500, "Bio must be at most 500 characters")
    .optional()
    .nullable(),
  role: z.enum(["CLIENT", "FREELANCER"]).optional(),
  skills: z.array(z.string()).max(20).optional(),
  availability: z.boolean().optional(),
});

/** Normalizes `skills[]` query keys from Express into `skills`. */
function normalizeFreelancerSearchQuery(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const o = { ...(raw as Record<string, unknown>) };
  if (o.skills === undefined && o["skills[]"] !== undefined) {
    o.skills = o["skills[]"];
  }
  delete o["skills[]"];
  return o;
}

export const freelancerSearchQuerySchema = z.preprocess(
  normalizeFreelancerSearchQuery,
  z.object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(12),
    minRating: z.coerce.number().min(0).max(5).optional(),
    available: z
      .preprocess((v) => {
        if (v === undefined || v === null || v === "") return undefined;
        if (typeof v === "boolean") return v;
        const s = String(v).toLowerCase();
        if (s === "true" || s === "1") return true;
        if (s === "false" || s === "0") return false;
        return undefined;
      }, z.boolean().optional()),
    q: z.string().optional(),
    skills: z
      .preprocess((v) => {
        if (v === undefined || v === null || v === "") return undefined;
        const arr = Array.isArray(v) ? v : [v];
        const out = arr.map((x) => String(x).trim()).filter(Boolean);
        return out.length ? out : undefined;
      }, z.array(z.string()).optional()),
  })
);
