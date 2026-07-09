import { z } from 'zod';

const positiveInt = z.number().int().positive();

/**
 * Shared username field: lowercase alphanumeric, dots, underscores, 3-30 chars.
 * Mirrors the USERNAME_REGEX previously inlined in the account/username and
 * signup routes. Normalizes to trimmed lowercase so handlers can use the parsed
 * value directly.
 */
export const usernameField = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z0-9._]{3,30}$/,
    'Username must be 3-30 characters and contain only lowercase letters, numbers, dots, and underscores',
  );

// PATCH /api/account/default-location
export const UpdateDefaultLocationSchema = z.object({
  locationId: positiveInt,
});

// PATCH /api/account/username
export const UpdateUsernameSchema = z.object({
  username: usernameField,
});

/**
 * PATCH /api/user/preferences — partial update of notification/profile prefs.
 * All fields optional; the handler applies only those present. defaultLocationId
 * accepts number|string because the handler parseInt()s it (legacy path — no
 * current caller sends it, but accepted to avoid rejecting older payloads).
 */
export const UpdateUserPreferencesSchema = z.object({
  emailAlerts: z.boolean().optional(),
  minLocationEmailAlerts: z.boolean().optional(),
  minCombinedEmailAlerts: z.boolean().optional(),
  defaultLocationId: z.union([z.number(), z.string()]).optional(),
});

export type UpdateDefaultLocationInput = z.infer<typeof UpdateDefaultLocationSchema>;
export type UpdateUsernameInput = z.infer<typeof UpdateUsernameSchema>;
export type UpdateUserPreferencesInput = z.infer<typeof UpdateUserPreferencesSchema>;
