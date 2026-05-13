import type {
  CatalogRow,
  InternalProductIndexEntry,
  Suggestion,
  SuggestionReason,
} from '@/types/bulk-map';
import {
  canonicalUnit,
  parseSizeToken,
  tokenize,
} from './normalize';

const TITLE_MIN = 50;
const SIZE_WEIGHT = 0.6;
const MAX_RESULTS = 5;

export interface InternalProductInput {
  id: number;
  name: string;
  baseName: string | null;
  variant: string | null;
  numericValue: number | null;
  unit: string | null;
  hasAnyMapping: boolean;
  existingMappingNote?: string;
}

export function buildIndex(
  products: InternalProductInput[],
): InternalProductIndexEntry[] {
  return products.map((p) => ({
    ...p,
    baseNameTokens: tokenize(p.baseName ?? p.name),
  }));
}

function tokenSubset(a: string[], b: string[]): boolean {
  return a.length > 0 && a.every((t) => b.includes(t));
}

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

function scoreTitle(parentTitleTokens: string[], internalTokens: string[]): number {
  if (parentTitleTokens.join(' ') === internalTokens.join(' ')) return 100;
  if (tokenSubset(internalTokens, parentTitleTokens) || tokenSubset(parentTitleTokens, internalTokens)) return 70;
  const j = jaccard(parentTitleTokens, internalTokens);
  if (j >= 0.5) return Math.round(50 * j);
  return 0;
}

function extractRowSize(row: CatalogRow): { value: number; unit: string } | null {
  const SIZE_ATTR = /size|weight|volume|count/i;
  const fromAttr = row.attributes.find((a) => SIZE_ATTR.test(a.name));
  if (fromAttr) {
    const parsed = parseSizeToken(fromAttr.option);
    if (parsed) return parsed;
  }
  if (row.variantTitle) {
    const parsed = parseSizeToken(row.variantTitle);
    if (parsed) return parsed;
  }
  return null;
}

function scoreSize(
  row: CatalogRow,
  product: InternalProductIndexEntry,
): number {
  if (row.type === 'simple') return 0;
  const rowSize = extractRowSize(row);
  if (!rowSize) return 0;
  if (product.numericValue === null) return 0;
  const internalUnit = product.unit ? canonicalUnit(product.unit) : null;
  if (product.numericValue !== rowSize.value) return 0;
  if (internalUnit === rowSize.unit) return 100;
  if (internalUnit === null) return 70;
  return 40;
}

export function suggest(
  row: CatalogRow,
  index: InternalProductIndexEntry[],
): Suggestion[] {
  const parentTokens = tokenize(row.parentTitle);
  const scored: Array<Suggestion & { final: number }> = [];

  for (const product of index) {
    const titleScore = scoreTitle(parentTokens, product.baseNameTokens);
    if (titleScore < TITLE_MIN) continue;
    const sizeScore = scoreSize(row, product);
    const final = titleScore + SIZE_WEIGHT * sizeScore;
    const reason: SuggestionReason =
      sizeScore > 0 && titleScore > 0
        ? 'title+size'
        : titleScore > 0
        ? 'title'
        : 'size';
    scored.push({
      product,
      score: final,
      reason,
      greyed: product.hasAnyMapping,
      final,
    });
  }

  scored.sort((a, b) => b.final - a.final);
  return scored.slice(0, MAX_RESULTS).map(({ final: _f, ...s }) => s);
}
