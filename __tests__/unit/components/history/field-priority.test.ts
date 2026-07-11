// @jest-environment node
//
// Lane 3 Task 2 — field-priority ordering (spec §11 D-L5 tables VERBATIM).
// Core-change-first: the per-entity priority table beats object insertion order;
// noise keys (updatedAt/createdAt/version) always sort last.
import { orderChanges } from '@/components/history/field-priority';
import type { ChangePair } from '@/lib/change-tracking/extract-changes';

const pair = (from: unknown, to: unknown): ChangePair => ({ from, to });

describe('orderChanges', () => {
  it('PRODUCT priority table beats insertion order', () => {
    // Insertion order deliberately reversed vs. the priority table.
    const changes: Record<string, ChangePair> = {
      retailPrice: pair(1, 2),
      quantity: pair(5, 6),
      name: pair('a', 'b'),
    };
    const ordered = orderChanges(changes, 'PRODUCT').map(([k]) => k);
    expect(ordered).toEqual(['name', 'quantity', 'retailPrice']);
  });

  it('INVENTORY table orders delta, location, reasonCode', () => {
    const changes: Record<string, ChangePair> = {
      reasonCode: pair(null, 'DAMAGE'),
      location: pair('A', 'B'),
      delta: pair(0, -3),
    };
    const ordered = orderChanges(changes, 'INVENTORY').map(([k]) => k);
    expect(ordered).toEqual(['delta', 'location', 'reasonCode']);
  });

  it('USER table orders isAdmin, isApproved, username', () => {
    const changes: Record<string, ChangePair> = {
      username: pair('x', 'y'),
      isApproved: pair(false, true),
      isAdmin: pair(false, true),
    };
    const ordered = orderChanges(changes, 'USER').map(([k]) => k);
    expect(ordered).toEqual(['isAdmin', 'isApproved', 'username']);
  });

  it('INTEGRATION table orders isActive, stockSyncEnabled, fulfillmentPushEnabled, syncLocationId', () => {
    const changes: Record<string, ChangePair> = {
      syncLocationId: pair(1, 2),
      fulfillmentPushEnabled: pair(false, true),
      stockSyncEnabled: pair(true, false),
      isActive: pair(false, true),
    };
    const ordered = orderChanges(changes, 'INTEGRATION').map(([k]) => k);
    expect(ordered).toEqual([
      'isActive',
      'stockSyncEnabled',
      'fulfillmentPushEnabled',
      'syncLocationId',
    ]);
  });

  it('noise keys (updatedAt/createdAt/version) always sort last', () => {
    const changes: Record<string, ChangePair> = {
      updatedAt: pair('t0', 't1'),
      version: pair(1, 2),
      quantity: pair(5, 6),
      name: pair('a', 'b'),
      createdAt: pair('c0', 'c1'),
    };
    const ordered = orderChanges(changes, 'PRODUCT').map(([k]) => k);
    // priority fields first, then the three noise keys in insertion order.
    expect(ordered.slice(0, 2)).toEqual(['name', 'quantity']);
    expect(ordered.slice(2)).toEqual(['updatedAt', 'version', 'createdAt']);
  });

  it('name/baseName share the top tier (relative insertion order kept)', () => {
    const changes: Record<string, ChangePair> = {
      variant: pair('v1', 'v2'),
      baseName: pair('b1', 'b2'),
    };
    const ordered = orderChanges(changes, 'PRODUCT').map(([k]) => k);
    expect(ordered).toEqual(['baseName', 'variant']);
  });

  it('fallback (unknown entity hint) keeps insertion order minus noise', () => {
    const changes: Record<string, ChangePair> = {
      alpha: pair(1, 2),
      updatedAt: pair('t0', 't1'),
      beta: pair(3, 4),
    };
    const ordered = orderChanges(changes, 'UNKNOWN').map(([k]) => k);
    expect(ordered).toEqual(['alpha', 'beta', 'updatedAt']);
  });

  it('non-priority fields on a known entity keep insertion order after priority fields', () => {
    const changes: Record<string, ChangePair> = {
      somethingElse: pair(1, 2),
      quantity: pair(5, 6),
      anotherField: pair(3, 4),
    };
    const ordered = orderChanges(changes, 'PRODUCT').map(([k]) => k);
    expect(ordered).toEqual(['quantity', 'somethingElse', 'anotherField']);
  });
});
