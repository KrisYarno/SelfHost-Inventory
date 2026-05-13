const UNIT_ALIASES: Record<string, string> = {
  lb: 'lb', lbs: 'lb', pound: 'lb', pounds: 'lb',
  oz: 'oz', ounce: 'oz', ounces: 'oz',
  'fl oz': 'fl oz', floz: 'fl oz', 'fluid ounce': 'fl oz', 'fluid ounces': 'fl oz',
  g: 'g', gram: 'g', grams: 'g',
  kg: 'kg', kgs: 'kg', kilogram: 'kg', kilograms: 'kg',
  ml: 'ml', milliliter: 'ml', milliliters: 'ml',
  l: 'l', liter: 'l', liters: 'l', litre: 'l', litres: 'l',
  gal: 'gal', gallon: 'gal', gallons: 'gal',
  ct: 'ct', count: 'ct', pcs: 'ct', pieces: 'ct', pack: 'ct',
};

const KNOWN_UNITS = Object.keys(UNIT_ALIASES).sort(
  (a, b) => b.length - a.length,
);

export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function tokenize(s: string): string[] {
  return normalizeText(s).split(' ').filter(Boolean);
}

export function canonicalUnit(unit: string): string {
  const key = normalizeText(unit);
  return UNIT_ALIASES[key] ?? key;
}

// Match a leading number (integer or decimal) followed by optional whitespace and the rest
const SIZE_TOKEN_RE = /^(\d+(?:\.\d+)?)\s*(.*)/;

export function parseSizeToken(raw: string): { value: number; unit: string } | null {
  // Normalize only the text portion; preserve decimal in the numeric portion
  const trimmed = raw.trim();
  const numMatch = trimmed.match(SIZE_TOKEN_RE);
  if (!numMatch) return null;
  const value = parseFloat(numMatch[1]);
  if (!Number.isFinite(value)) return null;

  const after = normalizeText(numMatch[2]);
  if (!after) return null;
  for (const candidate of KNOWN_UNITS) {
    if (after === candidate || after.startsWith(candidate + ' ')) {
      return { value, unit: UNIT_ALIASES[candidate] };
    }
  }
  return null;
}
