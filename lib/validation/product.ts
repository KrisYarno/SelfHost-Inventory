import { z } from 'zod';

const optionalTrimmedString = z
  .string()
  .trim()
  .max(255, 'Value is too long')
  .optional()
  .transform((value) => (value === undefined ? value : value));

const allowedUnits = ['mg', 'ml', 'mcg', 'iu'] as const;
type AllowedUnit = (typeof allowedUnits)[number];

// General-purpose create schema (kept lenient for scripts/imports)
export const ProductCreateSchema = z.object({
  name: z.string().trim().min(1, 'Product name is required').max(255),
  baseName: optionalTrimmedString,
  variant: optionalTrimmedString,
  unit: optionalTrimmedString,
  numericValue: z.number().nonnegative().optional(),
  costPrice: z.number().min(0, 'Cost must be >= 0').optional(),
  retailPrice: z.number().min(0, 'Retail must be >= 0').optional(),
  lowStockThreshold: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
    .optional(),
  locationId: z.number().int().positive().optional(),
});

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
  lowStockThreshold: z
    .number()
    .int()
    .min(0)
    .max(1_000_000)
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
    lowStockThreshold: z
      .number()
      .int()
      .min(0)
      .max(1_000_000)
      .optional(),
  })
  .refine(
    (data) => Object.values(data).some((value) => value !== undefined),
    {
      message: 'At least one field must be provided',
      path: ['_'],
    }
  );

export type ProductCreateInput = z.infer<typeof ProductCreateSchema>;
export type ProductUpdateInput = z.infer<typeof ProductUpdateSchema>;
