import { z } from 'zod';

const optionalTrimmedString = z
  .string()
  .trim()
  .max(255, 'Value is too long')
  .optional()
  .transform((value) => (value === undefined ? value : value));

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
