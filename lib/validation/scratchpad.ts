import { z } from "zod";

export const CreateScratchpadRowSchema = z.object({
  productId: z.number().int().positive(),
  label: z.string().min(1).max(120),
  value: z.string().max(255).nullish(),
  note: z.string().max(5000).nullish(),
  sortOrder: z.number().int().min(0).optional(),
});

export const PatchScratchpadRowSchema = z
  .object({
    expectedVersion: z.number().int().min(0),
    label: z.string().min(1).max(120).optional(),
    value: z.string().max(255).nullish(),
    note: z.string().max(5000).nullish(),
    sortOrder: z.number().int().min(0).optional(),
  })
  .refine(
    (d) =>
      d.label !== undefined ||
      d.value !== undefined ||
      d.note !== undefined ||
      d.sortOrder !== undefined,
    { message: "At least one field must be provided" },
  );

export const DeleteScratchpadRowSchema = z.object({
  expectedVersion: z.number().int().min(0),
});

export type CreateScratchpadRowInput = z.infer<typeof CreateScratchpadRowSchema>;
export type PatchScratchpadRowInput = z.infer<typeof PatchScratchpadRowSchema>;
