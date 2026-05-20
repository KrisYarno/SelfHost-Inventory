// @jest-environment node
import { parseWoosbIds } from '@/lib/platforms/woocommerce/parse-woosb-ids';

describe('parseWoosbIds', () => {
  it('parses single simple-product entry', () => {
    expect(parseWoosbIds('123/2')).toEqual([
      { productId: '123', variantId: null, quantity: 2 },
    ]);
  });

  it('parses multiple simple-product entries', () => {
    expect(parseWoosbIds('123/1,456/2,789/3')).toEqual([
      { productId: '123', variantId: null, quantity: 1 },
      { productId: '456', variantId: null, quantity: 2 },
      { productId: '789', variantId: null, quantity: 3 },
    ]);
  });

  it('parses variation format productId|variationId/qty (D6)', () => {
    expect(parseWoosbIds('100|200/2,300/1')).toEqual([
      { productId: '100', variantId: '200', quantity: 2 },
      { productId: '300', variantId: null, quantity: 1 },
    ]);
  });

  it('treats default quantity 1 when missing', () => {
    expect(parseWoosbIds('123,456')).toEqual([
      { productId: '123', variantId: null, quantity: 1 },
      { productId: '456', variantId: null, quantity: 1 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(parseWoosbIds('')).toEqual([]);
    expect(parseWoosbIds(null)).toEqual([]);
    expect(parseWoosbIds(undefined)).toEqual([]);
  });

  it('drops malformed entries silently and parses the rest', () => {
    expect(parseWoosbIds('123/2,bad-entry,456/1')).toEqual([
      { productId: '123', variantId: null, quantity: 2 },
      { productId: '456', variantId: null, quantity: 1 },
    ]);
  });

  it('handles whitespace around delimiters', () => {
    expect(parseWoosbIds(' 123/2 , 456/1 ')).toEqual([
      { productId: '123', variantId: null, quantity: 2 },
      { productId: '456', variantId: null, quantity: 1 },
    ]);
  });

  it('rejects non-positive quantities', () => {
    expect(parseWoosbIds('123/0,456/-1,789/2')).toEqual([
      { productId: '789', variantId: null, quantity: 2 },
    ]);
  });
});
