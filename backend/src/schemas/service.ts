import { z } from "zod";
import { paginationSchema } from "./common";

export const createServiceSchema = z.object({
  title: z
    .string()
    .min(5, "Title must be at least 5 characters long")
    .max(200, "Title must be less than 200 characters"),
  description: z
    .string()
    .min(20, "Description must be at least 20 characters long")
    .max(5000, "Description must be less than 5000 characters"),
  category: z.string().min(2, "Category is required"),
  price: z.number().positive("Price must be a positive number"),
  deliveryDays: z
    .number()
    .int()
    .positive("Delivery days must be a positive integer"),
  skills: z.array(z.string()).max(10, "Cannot have more than 10 skills").optional(),
});

export const updateServiceSchema = z.object({
  title: z
    .string()
    .min(5, "Title must be at least 5 characters long")
    .max(200, "Title must be less than 200 characters")
    .optional(),
  description: z
    .string()
    .min(20, "Description must be at least 20 characters long")
    .max(5000, "Description must be less than 5000 characters")
    .optional(),
  category: z.string().min(2, "Category is required").optional(),
  price: z.number().positive("Price must be a positive number").optional(),
  deliveryDays: z
    .number()
    .int()
    .positive("Delivery days must be a positive integer")
    .optional(),
  skills: z.array(z.string()).max(10, "Cannot have more than 10 skills").optional(),
});

export const getServicesQuerySchema = paginationSchema.extend({
  search: z.string().optional(),
  category: z.string().optional(),
  minPrice: z.coerce.number().positive().optional(),
  maxPrice: z.coerce.number().positive().optional(),
  freelancerId: z.string().optional(),
});

export const serviceIdParamSchema = z.object({
  id: z.string().cuid("Invalid id format"),
});
