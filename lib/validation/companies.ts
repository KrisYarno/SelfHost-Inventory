import { z } from 'zod';

/**
 * Company create + update share the same required shape (the PUT handler also
 * requires both name and slug). Slug format mirrors the `/^[a-z0-9-]+$/` regex
 * the routes previously enforced by hand. Lengths track the Prisma default
 * VarChar(191) for Company.name / Company.slug.
 */
export const CompanyInputSchema = z.object({
  name: z.string().trim().min(1, 'Name and slug are required').max(191),
  slug: z
    .string()
    .trim()
    .min(1, 'Name and slug are required')
    .max(191)
    .regex(
      /^[a-z0-9-]+$/,
      'Slug must contain only lowercase letters, numbers, and hyphens',
    ),
});

export type CompanyInput = z.infer<typeof CompanyInputSchema>;
