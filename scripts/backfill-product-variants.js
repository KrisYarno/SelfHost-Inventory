#!/usr/bin/env node
/**
 * Idempotent backfill helper for baseName/variant/unit/numericValue.
 * Defaults to DRY RUN. Set APPLY_CHANGES=true to perform updates.
 *
 * Parsing rules (simple, conservative):
 * - If baseName missing, split `name` on last space when variant looks like size (e.g., "10mg", "10 mg", "10mL", "5000iu").
 * - Extract numericValue/unit from variant when it matches {number}{unit}.
 * - Units normalized to mg/mL/mcg/iu casing as stored.
 *
 * Skips rows it cannot confidently parse.
 */
const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

const APPLY = process.env.APPLY_CHANGES === "true";
const allowedUnits = ["mg", "ml", "mcg", "iu"];

function parseVariant(variant) {
  if (!variant) return { variant: null, numericValue: null, unit: null };
  const trimmed = variant.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)(?:\s*)(mg|mL|ml|mcg|iu)$/i);
  if (match) {
    const numericValue = Number(match[1]);
    const unitRaw = match[2].toLowerCase();
    const unit = unitRaw === "ml" ? "mL" : unitRaw;
    return { variant: `${numericValue} ${unit}`, numericValue, unit: unit.toLowerCase() };
  }
  return { variant: trimmed, numericValue: null, unit: null };
}

function splitName(name) {
  if (!name) return { baseName: null, variant: null };
  const trimmed = name.trim();
  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return { baseName: trimmed, variant: null };
  const variant = parts.pop();
  const baseName = parts.join(" ");
  return { baseName, variant };
}

async function main() {
  const candidates = await prisma.product.findMany({
    where: {
      OR: [
        { baseName: null },
        { variant: null },
        { numericValue: null, unit: { not: null } },
        { numericValue: { not: null }, unit: null },
      ],
    },
  });

  console.log(`Found ${candidates.length} products needing evaluation`);

  for (const product of candidates) {
    let baseName = product.baseName;
    let variant = product.variant;
    let numericValue = product.numericValue ? Number(product.numericValue) : null;
    let unit = product.unit;

    if (!baseName || !variant) {
      const split = splitName(product.name);
      baseName = baseName || split.baseName;
      variant = variant || split.variant;
    }

    const parsed = parseVariant(variant || "");
    if (parsed.numericValue !== null) {
      variant = parsed.variant;
      numericValue = parsed.numericValue;
      unit = parsed.unit;
    } else if (!variant) {
      // No confident variant; skip
      console.log(`Skipping id=${product.id} (cannot parse name="${product.name}")`);
      continue;
    }

    // Validate unit
    if (unit && !allowedUnits.includes(unit.toLowerCase())) {
      console.log(`Skipping id=${product.id} (unit ${unit} not in allowed set)`);
      continue;
    }

    const updateData = {
      baseName: baseName || product.baseName,
      variant: variant || product.variant,
      unit: unit || null,
      numericValue: numericValue !== null ? numericValue : null,
      name: `${baseName || ""} ${variant || ""}`.trim(),
    };

    console.log(
      `${APPLY ? "Updating" : "Would update"} id=${product.id}:`,
      JSON.stringify(updateData)
    );

    if (APPLY) {
      await prisma.product.update({
        where: { id: product.id },
        data: updateData,
      });
    }
  }
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
