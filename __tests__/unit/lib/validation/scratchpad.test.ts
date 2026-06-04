/** @jest-environment node */
import { CreateScratchpadRowSchema, PatchScratchpadRowSchema, DeleteScratchpadRowSchema } from "@/lib/validation/scratchpad";

describe("scratchpad validation", () => {
  it("accepts a valid create (value optional)", () => {
    expect(CreateScratchpadRowSchema.safeParse({ productId: 1, label: "Awake Price" }).success).toBe(true);
    expect(CreateScratchpadRowSchema.safeParse({ productId: 1, label: "Awake Price", value: "40-50" }).success).toBe(true);
  });
  it("rejects a create with empty label", () => {
    expect(CreateScratchpadRowSchema.safeParse({ productId: 1, label: "" }).success).toBe(false);
  });
  it("rejects an empty PATCH (no mutable field) — prevents version churn", () => {
    expect(PatchScratchpadRowSchema.safeParse({ expectedVersion: 0 }).success).toBe(false);
  });
  it("accepts a PATCH that clears value to null (.nullish)", () => {
    expect(PatchScratchpadRowSchema.safeParse({ expectedVersion: 2, value: null }).success).toBe(true);
  });
  it("requires expectedVersion on delete", () => {
    expect(DeleteScratchpadRowSchema.safeParse({}).success).toBe(false);
    expect(DeleteScratchpadRowSchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
  });
});
