import { z } from 'zod';

const positiveInt = z.number().int().positive();

export const BulkUserIdsSchema = z.object({
  userIds: z.array(positiveInt).min(1, 'At least one user ID required'),
});

export const CreateLocationSchema = z.object({
  name: z.string().trim().min(1, 'Location name is required').max(100),
});

export const UpdateLocationSchema = z.object({
  name: z.string().trim().min(1).max(100).optional(),
}).refine(data => Object.values(data).some(v => v !== undefined), {
  message: 'At least one field must be provided',
});

// Shared password strength rules
const strongPassword = z.string()
  .min(10, 'Password must be at least 10 characters')
  .regex(/[a-z]/, 'Must contain a lowercase letter')
  .regex(/[A-Z]/, 'Must contain an uppercase letter')
  .regex(/[0-9]/, 'Must contain a digit');

export const CreatePasswordSchema = z.object({
  newPassword: strongPassword,
  confirmPassword: z.string(),
}).refine(data => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

export const ChangePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Current password is required'),
  newPassword: strongPassword,
  confirmPassword: z.string(),
}).refine(data => data.newPassword === data.confirmPassword, {
  message: 'Passwords do not match',
  path: ['confirmPassword'],
});

export const UpdateUserSchema = z.object({
  username: z.string().trim().min(2).max(50).optional(),
  isAdmin: z.boolean().optional(),
  isApproved: z.boolean().optional(),
  defaultLocationId: z.number().int().optional(),
}).refine(data => Object.values(data).some(v => v !== undefined), {
  message: 'At least one field must be provided',
});
