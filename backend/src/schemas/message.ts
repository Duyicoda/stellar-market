import { z } from 'zod';
import { paginationSchema } from './common';

export const createMessageSchema = z.object({
  receiverId: z.string().min(1, 'Receiver ID is required'),
  jobId: z.string().min(1, 'Job ID is required').optional(),
  content: z.string().min(1, 'Message content is required').max(2000, 'Message must be less than 2000 characters'),
});

export const updateMessageSchema = z.object({
  content: z.string().min(1, 'Message content is required').max(2000, 'Message must be less than 2000 characters'),
});

export const getMessagesQuerySchema = paginationSchema.extend({
  jobId: z.string().min(1).optional(),
  participantId: z.string().min(1).optional(),
});

export const getMessageByIdParamSchema = z.object({
  id: z.string().min(1, "ID is required"),
});

export const markMessageAsReadSchema = z.object({
  isRead: z.boolean(),
});