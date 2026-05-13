// @jest-environment node
import { buildIndex, suggest } from '@/lib/matching/suggestion-matcher';
import type { CatalogRow } from '@/types/bulk-map';

const internals = [
  { id: 1, name: 'Coffee Beans 1 lb', baseName: 'Coffee Beans', variant: '1 lb', numericValue: 1, unit: 'lb', hasAnyMapping: false },
  { id: 2, name: 'Coffee Beans 5 lb', baseName: 'Coffee Beans', variant: '5 lb', numericValue: 5, unit: 'lb', hasAnyMapping: false },
  { id: 3, name: 'Dark Roast Coffee Beans 1 lb', baseName: 'Dark Roast Coffee Beans', variant: '1 lb', numericValue: 1, unit: 'lb', hasAnyMapping: false },
  { id: 4, name: 'Earl Grey Tea 50 ct', baseName: 'Earl Grey Tea', variant: '50 ct', numericValue: 50, unit: 'ct', hasAnyMapping: true },
];

const index = buildIndex(internals);

function row(p: Partial<CatalogRow> & Pick<CatalogRow, 'parentTitle' | 'type'>): CatalogRow {
  return {
    externalProductId: 'x',
    externalVariantId: null,
    variantTitle: null,
    sku: null,
    attributes: [],
    alreadyMapped: false,
    ...p,
  };
}

describe('suggest', () => {
  it('returns the title+size match first', () => {
    const r = row({
      parentTitle: 'Coffee Beans',
      type: 'variation',
      externalVariantId: '1',
      variantTitle: '1 lb',
      attributes: [{ name: 'Size', option: '1lb' }],
    });
    const s = suggest(r, index);
    expect(s[0].product.id).toBe(1);
    expect(s[0].reason).toBe('title+size');
  });

  it('falls back to title-only when size does not match', () => {
    const r = row({
      parentTitle: 'Coffee Beans',
      type: 'variation',
      externalVariantId: '2',
      variantTitle: '10 lb',
      attributes: [{ name: 'Size', option: '10lb' }],
    });
    const s = suggest(r, index);
    expect(s.find((x) => x.product.id === 1)?.reason).toBe('title');
  });

  it('ranks size-bonus title matches above title-only matches', () => {
    const r = row({
      parentTitle: 'Coffee Beans',
      type: 'variation',
      externalVariantId: '1',
      variantTitle: '1 lb',
      attributes: [{ name: 'Size', option: '1lb' }],
    });
    const s = suggest(r, index);
    expect(s.findIndex((x) => x.product.id === 1)).toBeLessThan(
      s.findIndex((x) => x.product.id === 3),
    );
  });

  it('marks already-mapped internals as greyed but still returns them', () => {
    const r = row({
      parentTitle: 'Earl Grey Tea',
      type: 'variation',
      externalVariantId: '50',
      variantTitle: '50 ct',
      attributes: [{ name: 'Count', option: '50ct' }],
    });
    const s = suggest(r, index);
    const tea = s.find((x) => x.product.id === 4);
    expect(tea).toBeDefined();
    expect(tea!.greyed).toBe(true);
  });

  it('skips internals below the title threshold', () => {
    const r = row({
      parentTitle: 'Sparkling Water Mango',
      type: 'simple',
    });
    const s = suggest(r, index);
    expect(s).toHaveLength(0);
  });

  it('returns at most 5 suggestions', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      id: 100 + i,
      name: `Coffee Beans Variant ${i}`,
      baseName: 'Coffee Beans',
      variant: `${i} lb`,
      numericValue: i,
      unit: 'lb',
      hasAnyMapping: false,
    }));
    const idx = buildIndex(many);
    const r = row({ parentTitle: 'Coffee Beans', type: 'simple' });
    expect(suggest(r, idx).length).toBeLessThanOrEqual(5);
  });
});
