/**
 * The three classes a skipped workbench line can belong to, and the ONE copy
 * each of them gets (contract pack REV-3 T6; extracted at W1-4b).
 *
 * `unmappedExternalItems` (hooks/use-workbench.ts `selectExternalOrder`) mixes
 * three different truths under one array name:
 *
 *   bundle       the line IS mapped, but a bundle cannot sit in the workbench
 *                cart (cart entries are 1:1 with one internal product) — the
 *                operator fulfills it from the Order Details sheet;
 *   unavailable  the line IS mapped, but its internal product was not in the
 *                loaded products array, so it could not be added to the cart;
 *   unmapped     the line was never mapped at all.
 *
 * W0.5-a taught the COMPLETE dialog to say all three. The page-level alert kept
 * calling every non-bundle line "unmapped", so the same array told two stories
 * depending on which surface you were looking at. This module is the cure: both
 * surfaces import the classifier and the strings, so the next copy change
 * cannot land on only one of them.
 *
 * CLASS DETECTION: `isBundle` is set only by the bundle push. The
 * mapped-but-not-loaded push is the ONLY one that omits the external product
 * reference (every ExternalOrderItem carries a non-null `externalProductId` —
 * prisma schema VarChar(255) NOT NULL — and the unmapped push forwards it), so
 * a missing reference is what separates the two non-bundle classes.
 *
 * Pure: no React, no Next, no Prisma.
 */

export type SkippedLineClass = 'unmapped' | 'unavailable' | 'bundle';

/** The per-line truth. Bundles are the only class that still ships correctly. */
export const SKIPPED_LINE_COPY: Record<SkippedLineClass, string> = {
  unmapped: 'ships unmapped — not deducted',
  unavailable: 'mapped but unavailable — not deducted',
  bundle: 'bundle — fulfill via Order Details',
};

export const SKIPPED_LINE_LABEL: Record<SkippedLineClass, string> = {
  unmapped: 'Unmapped',
  unavailable: 'Mapped but unavailable',
  bundle: 'Bundles',
};

/**
 * The noun each class gets in a SUMMARY line, singular and plural. Separate
 * from {@link SKIPPED_LINE_LABEL} (which heads a group) because "1 Bundles" is
 * not a sentence — and a banner nobody can read is a banner nobody obeys.
 */
export const SKIPPED_LINE_NOUN: Record<SkippedLineClass, [string, string]> = {
  unmapped: ['unmapped line', 'unmapped lines'],
  unavailable: ['mapped but unavailable line', 'mapped but unavailable lines'],
  bundle: ['bundle line', 'bundle lines'],
};

/** Render order: the lines that need a tap first, the informational ones last. */
export const SKIPPED_LINE_CLASSES: readonly SkippedLineClass[] = [
  'unmapped',
  'unavailable',
  'bundle',
];

/**
 * The fields the classification reads. `class` (W2-1 ride-along) is the
 * STRUCTURAL answer stamped by the push site itself; the other three are the
 * as-built heuristic that has to reconstruct it.
 */
export type ClassifiableLine = {
  class?: SkippedLineClass;
  isBundle?: boolean;
  externalProductId?: string | null;
  externalVariantId?: string | null;
};

/**
 * A RECORDED class always wins: the hook branch that pushed the line knew which
 * of the three truths it was pushing, and that beats re-deducing it from the
 * shape of the payload.
 *
 * The heuristic stays as the fallback rather than being deleted, because a line
 * that reaches here without the field (built outside the hook, or by a caller
 * written before it existed) must degrade to the old answer — not to a wrong
 * one. `unavailable` is what an empty object has always meant here.
 */
export function classifySkippedLine(item: ClassifiableLine): SkippedLineClass {
  if (item.class) return item.class;
  if (item.isBundle) return 'bundle';
  if (!item.externalProductId && !item.externalVariantId) return 'unavailable';
  return 'unmapped';
}
