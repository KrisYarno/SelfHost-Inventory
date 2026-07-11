import { z } from 'zod';

const optionalTrimmedString = z
  .string()
  .trim()
  .max(255, 'Value is too long')
  .optional()
  .transform((value) => (value === undefined ? value : value));

const allowedUnits = ['mg', 'ml', 'mcg', 'iu'] as const;
type AllowedUnit = (typeof allowedUnits)[number];

// Stricter schema for UI-driven product creation
export const ProductCreateUISchema = z.object({
  baseName: z.string().trim().min(1, 'Base name is required').max(150),
  variant: z.string().trim().min(1, 'Variant is required').max(100),
  unit: z
    .string()
    .trim()
    .toLowerCase()
    .transform((v) => (v === '' ? undefined : v) as string | undefined)
    .refine(
      (v) => v === undefined || allowedUnits.includes(v as AllowedUnit),
      'Unit must be one of mg, ml, mcg, or iu'
    )
    .optional(),
  numericValue: z
    .number()
    .nonnegative('Numeric value must be >= 0')
    .max(1_000_000, 'Numeric value is too large')
    .optional(),
  // NULL = inherit the system default (spec R-L13). undefined = field omitted;
  // both are honored — the create path writes NULL unless an explicit value is set.
  lowStockThreshold: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .nullable()
    .optional(),
  costPrice: z.number().min(0, 'Cost must be >= 0').optional(),
  retailPrice: z.number().min(0, 'Retail must be >= 0').optional(),
  locationId: z.number().int().positive().optional(),
}).superRefine((data, ctx) => {
  const hasNumeric = data.numericValue !== undefined && data.numericValue !== null;
  const hasUnit = !!data.unit;

  // Enforce paired presence for size-based products
  if (hasNumeric && !hasUnit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Unit is required when numeric value is provided',
      path: ['unit'],
    });
  }
  if (hasUnit && !hasNumeric) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Numeric value is required when unit is provided',
      path: ['numericValue'],
    });
  }
});

export const ProductUpdateSchema = z
  .object({
    name: optionalTrimmedString,
    baseName: optionalTrimmedString,
    variant: optionalTrimmedString,
    unit: optionalTrimmedString,
    numericValue: z.number().nonnegative().optional(),
    costPrice: z.number().min(0, 'Cost must be >= 0').optional(),
    retailPrice: z.number().min(0, 'Retail must be >= 0').optional(),
    // NULL = inherit the system default (spec R-L13); the PUT diffs and persists
    // null distinctly from 0 (disabled) and from an explicit override.
    lowStockThreshold: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional(),
  })
  .refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    {
      message: 'At least one field must be provided',
      path: ['_'],
    }
  );

export type ProductUpdateInput = z.infer<typeof ProductUpdateSchema>;

/**
 * POST /api/products/[id]/price-source — set/clear a product's price source.
 * linkId = null (or absent) clears it; a string links to a productLink. syncNow
 * optionally triggers an immediate price pull.
 */
export const PriceSourceSchema = z.object({
  linkId: z.string().nullable().optional(),
  syncNow: z.boolean().optional(),
});

export type PriceSourceInput = z.infer<typeof PriceSourceSchema>;
