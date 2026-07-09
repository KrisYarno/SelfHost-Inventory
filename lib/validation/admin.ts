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

// Shared password strength rules (also reused by the public signup schema).
export const strongPassword = z.string()
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

// POST /api/admin/settings — toggle system-level boolean SystemSettings.
// Both optional; the handler upserts only the flags actually provided.
export const SystemSettingsSchema = z.object({
  weeklyReportsEnabled: z.boolean().optional(),
  analyticsRebuildEnabled: z.boolean().optional(),
});

// PATCH /api/admin/products/thresholds — bulk minimum-quantity updates.
// combinedMinimum maps to Product.lowStockThreshold (Int); perLocation entries
// map to product_locations.minQuantity (Int). Both bounded at >= 0, replacing
// the route's inline negative-value guards.
const ThresholdUpdateSchema = z.object({
  productId: z.number().int().positive(),
  combinedMinimum: z
    .number()
    .int()
    .min(0, 'Combined minimum cannot be negative')
    .optional(),
  perLocation: z
    .array(
      z.object({
        locationId: z.number().int().positive(),
        minQuantity: z.number().int().min(0, 'Location minimum cannot be negative'),
      }),
    )
    .optional(),
});

export const ThresholdsUpdateSchema = z.object({
  updates: z.array(ThresholdUpdateSchema).min(1, 'No updates provided'),
});

// POST /api/admin/audit-logs — fetch a batch's logs by its batchId.
export const AuditBatchLogsSchema = z.object({
  batchId: z.string().min(1, 'Batch ID is required'),
});

export type SystemSettingsInput = z.infer<typeof SystemSettingsSchema>;
export type ThresholdsUpdateInput = z.infer<typeof ThresholdsUpdateSchema>;
