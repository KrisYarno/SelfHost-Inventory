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

// POST /api/admin/settings — update system-level SystemSettings. All optional;
// the handler upserts only the keys actually provided. lowStockDefaultThreshold
// (spec R-L13/D-L9) is the system-wide default alert threshold products inherit
// when their own lowStockThreshold is NULL; 0 is valid (disables inheritors).
export const SystemSettingsSchema = z.object({
  weeklyReportsEnabled: z.boolean().optional(),
  analyticsRebuildEnabled: z.boolean().optional(),
  lowStockDefaultThreshold: z.number().int().min(0).max(1_000_000).optional(),
  // Lane 6 (R-E9, codex #24): the runtime emergency stop. WITHOUT this line the
  // settings route validates against this allowlist and silently STRIPS the key,
  // so the admin "Block all platform writes now" control would no-op. `true`
  // blocks every platform write; it can only ever RESTRICT (egress ANDs it in).
  platformWritesKillSwitch: z.boolean().optional(),
});

// PATCH /api/admin/products/thresholds — bulk minimum-quantity updates.
// combinedMinimum maps to Product.lowStockThreshold (Int); perLocation entries
// map to product_locations.minQuantity (Int). Both bounded at >= 0, replacing
// the route's inline negative-value guards.
const ThresholdUpdateSchema = z.object({
  productId: z.number().int().positive(),
  // NULL = clear the override / inherit the system default; 0 = alerts off;
  // >0 = explicit override (spec R-L13 tri-state). Distinct from an omitted field.
  combinedMinimum: z
    .number()
    .int()
    .min(0, 'Combined minimum cannot be negative')
    .nullable()
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

// PUT /api/admin/reorder-settings — the global reorder defaults (the singleton
// global_reorder_settings row). All optional; the handler updates only provided keys.
// leadTime default is always positive (>= 1). bufferDays default allows 0 (no buffer).
// targetCoverageMultiple >= 1; minEvidenceEvents >= 0. Allowlisted so a field is not
// silently stripped (codex #13).
export const GlobalReorderSettingsSchema = z.object({
  defaultLeadTimeDays: z.number().int().min(1).max(3650).optional(),
  defaultSafetyStockDays: z.number().int().min(0).max(3650).optional(),
  defaultTargetCoverageMultiple: z.number().int().min(1).max(100).optional(),
  minEvidenceEvents: z.number().int().min(0).max(1000).optional(),
}).refine((data) => Object.values(data).some((v) => v !== undefined), {
  message: 'At least one field must be provided',
});

export type GlobalReorderSettingsInput = z.infer<typeof GlobalReorderSettingsSchema>;
export type SystemSettingsInput = z.infer<typeof SystemSettingsSchema>;
export type ThresholdsUpdateInput = z.infer<typeof ThresholdsUpdateSchema>;
