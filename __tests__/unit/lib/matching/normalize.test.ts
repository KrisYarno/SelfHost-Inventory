// @jest-environment node
import {
  normalizeText,
  tokenize,
  canonicalUnit,
  parseSizeToken,
} from '@/lib/matching/normalize';

describe('normalizeText', () => {
  it('lowercases', () => expect(normalizeText('Coffee')).toBe('coffee'));
  it('strips punctuation except spaces', () =>
    expect(normalizeText('Coffee! Beans?')).toBe('coffee beans'));
  it('collapses whitespace', () =>
    expect(normalizeText('Coffee   Beans')).toBe('coffee beans'));
  it('handles unicode reasonably', () =>
    expect(normalizeText("Café Beans")).toBe('caf beans'));
});

describe('tokenize', () => {
  it('splits on whitespace', () =>
    expect(tokenize('coffee beans')).toEqual(['coffee', 'beans']));
  it('drops empty tokens', () =>
    expect(tokenize('  coffee   beans ')).toEqual(['coffee', 'beans']));
});

describe('canonicalUnit', () => {
  it.each([
    ['lb', 'lb'],
    ['lbs', 'lb'],
    ['pound', 'lb'],
    ['pounds', 'lb'],
    ['oz', 'oz'],
    ['ounce', 'oz'],
    ['ounces', 'oz'],
    ['fl oz', 'fl oz'],
    ['floz', 'fl oz'],
    ['fluid ounce', 'fl oz'],
    ['fluid ounces', 'fl oz'],
    ['g', 'g'],
    ['gram', 'g'],
    ['grams', 'g'],
    ['kg', 'kg'],
    ['kilogram', 'kg'],
    ['kilograms', 'kg'],
    ['ml', 'ml'],
    ['milliliter', 'ml'],
    ['l', 'l'],
    ['liter', 'l'],
    ['litres', 'l'],
    ['gal', 'gal'],
    ['gallon', 'gal'],
    ['gallons', 'gal'],
    ['ct', 'ct'],
    ['count', 'ct'],
    ['pcs', 'ct'],
    ['pieces', 'ct'],
    ['pack', 'ct'],
  ])('canonicalises %s -> %s', (input, expected) => {
    expect(canonicalUnit(input)).toBe(expected);
  });

  it('returns the input unchanged for unknown units', () =>
    expect(canonicalUnit('widget')).toBe('widget'));
});

describe('parseSizeToken', () => {
  it.each([
    ['1lb', { value: 1, unit: 'lb' }],
    ['1 lb', { value: 1, unit: 'lb' }],
    ['12oz', { value: 12, unit: 'oz' }],
    ['12 fl oz', { value: 12, unit: 'fl oz' }],
    ['500ml', { value: 500, unit: 'ml' }],
    ['1.5 lb', { value: 1.5, unit: 'lb' }],
    ['24 ct', { value: 24, unit: 'ct' }],
    ['1 gallon', { value: 1, unit: 'gal' }],
  ])('parses %s', (input, expected) => {
    expect(parseSizeToken(input)).toEqual(expected);
  });

  it('returns null for tokens without a number', () =>
    expect(parseSizeToken('Dark Roast')).toBeNull());
  it('returns null for tokens without a recognised unit', () =>
    expect(parseSizeToken('42')).toBeNull());
});
