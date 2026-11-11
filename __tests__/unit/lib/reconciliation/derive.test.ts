// @jest-environment node
//
// Reconciliation lane R-B (spec REV-7 §2.4, pack C2a.2) — THE HISTORICAL
// DERIVATION.
//
// Every population batch that has no attempt row gets a class computed at READ
// time, and the rule set is TOTAL: there is no "unrecorded", no null class, no
// batch the report has to shrug at. That totality is the property worth pinning
// hardest — one `it` per rule proves each rule can fire, and the hand table at
// the bottom proves that every stamped/unstamped x event-shape combination
// lands on exactly ONE of them.
//
// Three orderings are load-bearing and none is obvious from the names:
//
//   * R2 vs R2b keys on the STAMP, not on the event. The same fulfillment audit
//     event means "attributed" when the ledger carries the id and "attributed,
//     but the ledger was never stamped" when it does not — and the second is a
//     repairable defect (D4 stamp completion), not a different kind of sale.
//   * R4 is checked BEFORE R5. The workbench "Other" tap always sends a typed
//     reference along with the chip, so an operator who SAID this was not an
//     order must never be counted as a decline that nobody recorded.
//   * "The audit event" is the EARLIEST row by id, never the newest and never
//     the first one the caller happened to hand over.
import {
  DERIVED_SENTENCES,
  deriveHistoricalAttempt,
  type DeriveAuditEvent,
  type DeriveBatch,
  type DerivedClass,
} from '@/lib/reconciliation/derive';

const AT = new Date('2026-08-01T10:00:00.000Z');
const NO_RECORDING = { recordingSince: null } as const;

function batch(over: Partial<DeriveBatch> = {}): DeriveBatch {
  return { batchId: 'batch-1', stamps: [null], at: AT, ...over };
}

function ev(over: Partial<DeriveAuditEvent> = {}): DeriveAuditEvent {
  return { id: 1, actionType: 'INVENTORY_BULK_UPDATE', entityId: null, details: {}, ...over };
}

describe('R1 — the deduction recorded WHICH evidence stamped it', () => {
  it('stamped + details.orderAttributionSource = selected -> attributed/selected', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_1'] }),
        [ev({ details: { orderAttributionSource: 'selected' } })],
        NO_RECORDING
      )
    ).toEqual({
      outcome: 'attributed',
      evidence: 'selected',
      ruleId: 'R1',
      sentence: DERIVED_SENTENCES.R1,
    });
  });

  it('stamped + details.orderAttributionSource = reference-resolved -> attributed/reference-resolved', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_1'] }),
        [ev({ details: { orderAttributionSource: 'reference-resolved' } })],
        NO_RECORDING
      )
    ).toEqual({
      outcome: 'attributed',
      evidence: 'reference-resolved',
      ruleId: 'R1',
      sentence: DERIVED_SENTENCES.R1,
    });
  });

  it('an UNKNOWN source token is not evidence — it falls through to R3', () => {
    // The evidence vocabulary is closed. A token nobody declared cannot be
    // reported as a confidence level, and "stamped by an unrecorded path" is the
    // truthful answer for a stamp whose evidence we cannot read.
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_1'] }),
        [ev({ details: { orderAttributionSource: 'telepathy' } })],
        NO_RECORDING
      ).ruleId
    ).toBe('R3');
  });
});

describe('R1b — a stamped ADJUSTMENT the operator marked as an order', () => {
  it('stamped + INVENTORY_ADJUSTMENT with intent=order -> attributed/selected', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_2'] }),
        [ev({ actionType: 'INVENTORY_ADJUSTMENT', details: { intent: 'order' } })],
        NO_RECORDING
      )
    ).toEqual({
      outcome: 'attributed',
      evidence: 'selected',
      ruleId: 'R1b',
      sentence: DERIVED_SENTENCES.R1b,
    });
  });
});

// B3-1 FR1 (CR-2): the adjust capture's event now records WHICH evidence
// stamped it. When the attempt insert is swallowed the report derives the class,
// and a typed number that resolved must read as R1's `reference-resolved` — not
// as R1b's blanket `selected`, which is still the reading for older rows.
describe('the adjust capture recorded its source (B3-1 FR1)', () => {
  const adjustEvent = (details: Record<string, unknown>) =>
    ev({ actionType: 'INVENTORY_ADJUSTMENT', entityId: '5', details });

  it('stamped + an order-intent adjust that recorded reference-resolved -> R1, not R1b', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_2'] }),
        [
          adjustEvent({
            intent: 'order',
            orderReference: '12345',
            orderAttributionSource: 'reference-resolved',
          }),
        ],
        NO_RECORDING
      )
    ).toEqual({
      outcome: 'attributed',
      evidence: 'reference-resolved',
      ruleId: 'R1',
      sentence: DERIVED_SENTENCES.R1,
    });
  });

  it('the SAME event without the source key still derives R1b `selected` (older rows)', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_2'] }),
        [adjustEvent({ intent: 'order', orderReference: '12345' })],
        NO_RECORDING
      )
    ).toEqual({
      outcome: 'attributed',
      evidence: 'selected',
      ruleId: 'R1b',
      sentence: DERIVED_SENTENCES.R1b,
    });
  });
});

describe('R2 / R2b — fulfillment, keyed on the STAMP', () => {
  const fulfillment = ev({
    actionType: 'EXTERNAL_ORDER_FULFILLMENT',
    entityId: 'ord_3',
    details: { orderId: 'ord_3', fulfilled: 2 },
  });

  it('R2: stamped + EXTERNAL_ORDER_FULFILLMENT -> attributed/fulfillment', () => {
    expect(
      deriveHistoricalAttempt(batch({ stamps: ['ord_3'] }), [fulfillment], NO_RECORDING)
    ).toEqual({
      outcome: 'attributed',
      evidence: 'fulfillment',
      ruleId: 'R2',
      sentence: DERIVED_SENTENCES.R2,
    });
  });

  it('R2: the PARTIAL fulfillment actionType counts the same', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_3'] }),
        [ev({ actionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT', details: { orderId: 'ord_3' } })],
        NO_RECORDING
      ).ruleId
    ).toBe('R2');
  });

  it('R2b: the SAME event with an UNSTAMPED ledger -> ledgerUnstamped', () => {
    expect(deriveHistoricalAttempt(batch(), [fulfillment], NO_RECORDING)).toEqual({
      outcome: 'attributed',
      evidence: 'fulfillment',
      ruleId: 'R2b',
      ledgerUnstamped: true,
      sentence: DERIVED_SENTENCES.R2b,
    });
  });

  it('R2b: the order may be named by entityId when details.orderId is absent', () => {
    expect(
      deriveHistoricalAttempt(
        batch(),
        [ev({ actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityId: 'ord_4', details: {} })],
        NO_RECORDING
      ).ruleId
    ).toBe('R2b');
  });

  it('R2b needs an order NAME: a fulfillment event naming none is not evidence', () => {
    expect(
      deriveHistoricalAttempt(
        batch(),
        [ev({ actionType: 'EXTERNAL_ORDER_FULFILLMENT', entityId: null, details: {} })],
        NO_RECORDING
      ).ruleId
    ).toBe('R7');
  });
});

describe('R3a / R3 — stamped, with and without readable evidence', () => {
  it('R3a: the audit event names the SAME order the ledger carries -> attributed/selected', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_5'] }),
        [ev({ details: { selectedExternalOrderId: 'ord_5' } })],
        NO_RECORDING
      )
    ).toEqual({
      outcome: 'attributed',
      evidence: 'selected',
      ruleId: 'R3a',
      sentence: DERIVED_SENTENCES.R3a,
    });
  });

  it('R3a does NOT fire when the named order is a different one', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_5'] }),
        [ev({ details: { selectedExternalOrderId: 'ord_6' } })],
        NO_RECORDING
      ).ruleId
    ).toBe('R3');
  });

  it('R3a does NOT fire on a MIXED batch (there is no single stamp to equal)', () => {
    // Mixed stamps are reported by their own tripwire (spec §2.2), never averaged
    // and never quietly matched against one of the two ids.
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_5', 'ord_6'] }),
        [ev({ details: { selectedExternalOrderId: 'ord_5' } })],
        NO_RECORDING
      ).ruleId
    ).toBe('R3');
  });

  it('R3: stamped with no audit event at all -> attributed/derived', () => {
    expect(deriveHistoricalAttempt(batch({ stamps: ['ord_7'] }), [], NO_RECORDING)).toEqual({
      outcome: 'attributed',
      evidence: 'derived',
      ruleId: 'R3',
      sentence: DERIVED_SENTENCES.R3,
    });
  });
});

describe('R4 / R5 / R6 / R7 — unstamped', () => {
  it('R4: the operator said this was not an order', () => {
    for (const intent of ['other', 'damage-loss'] as const) {
      expect(
        deriveHistoricalAttempt(batch(), [ev({ details: { intent } })], NO_RECORDING)
      ).toEqual({
        outcome: 'none',
        reason: 'explicit-non-order-intent',
        ruleId: 'R4',
        sentence: DERIVED_SENTENCES.R4,
      });
    }
  });

  it('R4 BEFORE R5: the workbench "Other" tap sends a reference too, and it is not a decline', () => {
    expect(
      deriveHistoricalAttempt(
        batch(),
        [ev({ details: { intent: 'other', orderReference: '23716' } })],
        NO_RECORDING
      ).ruleId
    ).toBe('R4');
  });

  it('R5: a reference was typed and nothing recorded what became of it', () => {
    expect(
      deriveHistoricalAttempt(
        batch(),
        [ev({ details: { orderReference: '23716' } })],
        NO_RECORDING
      )
    ).toEqual({
      outcome: 'declined',
      reason: 'unknown',
      ruleId: 'R5',
      sentence: DERIVED_SENTENCES.R5,
    });
  });

  it('R6: intent=order with nothing to stamp', () => {
    expect(
      deriveHistoricalAttempt(batch(), [ev({ details: { intent: 'order' } })], NO_RECORDING)
    ).toEqual({
      outcome: 'none',
      reason: 'order-intent-no-id',
      ruleId: 'R6',
      sentence: DERIVED_SENTENCES.R6,
    });
  });

  it('R7: nothing at all', () => {
    expect(deriveHistoricalAttempt(batch(), [], NO_RECORDING)).toEqual({
      outcome: 'none',
      reason: 'unknown',
      ruleId: 'R7',
      sentence: DERIVED_SENTENCES.R7,
    });
  });

  it('R7: a NULL details column is not evidence of anything', () => {
    expect(deriveHistoricalAttempt(batch(), [ev({ details: null })], NO_RECORDING).ruleId).toBe(
      'R7'
    );
  });
});

describe('precedence between rules that could both fire', () => {
  it('R1 wins over R3a (the recorded source beats the accrued id)', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_8'] }),
        [
          ev({
            details: { orderAttributionSource: 'selected', selectedExternalOrderId: 'ord_8' },
          }),
        ],
        NO_RECORDING
      ).ruleId
    ).toBe('R1');
  });

  it('R1b wins over R3a on a stamped adjust that carries both', () => {
    expect(
      deriveHistoricalAttempt(
        batch({ stamps: ['ord_8'] }),
        [
          ev({
            actionType: 'INVENTORY_ADJUSTMENT',
            details: { intent: 'order', selectedExternalOrderId: 'ord_8' },
          }),
        ],
        NO_RECORDING
      ).ruleId
    ).toBe('R1b');
  });
});

describe('"the audit event" = the EARLIEST row by id', () => {
  it('the smaller id decides, even when it is the later timestamp on the wire', () => {
    // The deduction's OWN event is the one with the smallest id under this
    // batchId. A later event (an INVENTORY_ATTRIBUTE row carries a different
    // batchId entirely, but the caller may still hand over more than one row)
    // must not be able to re-classify the deduction.
    const earliest = ev({ id: 3, details: { intent: 'other' } });
    const later = ev({ id: 7, details: { orderAttributionSource: 'selected' } });
    expect(deriveHistoricalAttempt(batch(), [later, earliest], NO_RECORDING).ruleId).toBe('R4');
    expect(deriveHistoricalAttempt(batch(), [earliest, later], NO_RECORDING).ruleId).toBe('R4');
  });

  it('reversing the two ids reverses the verdict (the order in the array never matters)', () => {
    const a = ev({ id: 3, actionType: 'EXTERNAL_ORDER_FULFILLMENT', details: { orderId: 'o' } });
    const b = ev({ id: 7, details: { intent: 'other' } });
    expect(deriveHistoricalAttempt(batch(), [b, a], NO_RECORDING).ruleId).toBe('R2b');
  });
});

describe('post-lane gap (spec §2.2 — never "before the lane" after recording started)', () => {
  const since = new Date('2026-08-25T19:31:53.405Z');

  it('a batch AT the boundary is annotated', () => {
    const result = deriveHistoricalAttempt(batch({ at: since }), [], { recordingSince: since });
    expect(result.postLaneGap).toBe(true);
  });

  it('a batch AFTER the boundary is annotated', () => {
    const result = deriveHistoricalAttempt(batch({ at: new Date(since.getTime() + 1) }), [], {
      recordingSince: since,
    });
    expect(result.postLaneGap).toBe(true);
  });

  it('a batch BEFORE the boundary carries no annotation key at all', () => {
    const result = deriveHistoricalAttempt(batch({ at: new Date(since.getTime() - 1) }), [], {
      recordingSince: since,
    });
    expect(result.postLaneGap).toBeUndefined();
    expect(Object.keys(result)).not.toContain('postLaneGap');
  });

  it('recordingSince = null (recording has not started) never annotates', () => {
    const result = deriveHistoricalAttempt(
      batch({ at: new Date('2027-01-01T00:00:00.000Z') }),
      [],
      NO_RECORDING
    );
    expect(result.postLaneGap).toBeUndefined();
  });

  it('a post-lane R7 does not claim the batch predates the lane', () => {
    // The static R7 sentence says "before recording began". For a batch
    // recorded after the boundary that would be a false statement on the chip,
    // so the sentence is swapped for the honest one (spec §2.2 wins over the
    // pack's example).
    const result = deriveHistoricalAttempt(batch({ at: since }), [], { recordingSince: since });
    expect(result.ruleId).toBe('R7');
    expect(result.sentence).not.toContain('before recording began');
    expect(DERIVED_SENTENCES.R7).toContain('before recording began');
  });

  it('the annotation rides on top of the class, it does not change it', () => {
    const result = deriveHistoricalAttempt(batch({ stamps: ['ord_9'], at: since }), [], {
      recordingSince: since,
    });
    expect(result).toEqual({
      outcome: 'attributed',
      evidence: 'derived',
      ruleId: 'R3',
      postLaneGap: true,
      sentence: DERIVED_SENTENCES.R3,
    });
  });
});

describe('DERIVED_SENTENCES', () => {
  const RULE_IDS: Array<DerivedClass['ruleId']> = [
    'R1',
    'R1b',
    'R2',
    'R2b',
    'R3a',
    'R3',
    'R4',
    'R5',
    'R6',
    'R7',
  ];

  it('carries one non-empty sentence per ruleId and nothing else', () => {
    expect(Object.keys(DERIVED_SENTENCES).sort()).toEqual([...RULE_IDS].sort());
    for (const id of RULE_IDS) expect(DERIVED_SENTENCES[id].length).toBeGreaterThan(0);
  });

  it('pins the three sentences the pack spells out', () => {
    expect(DERIVED_SENTENCES.R2b).toBe('fulfillment (inferred — the ledger was never stamped)');
    expect(DERIVED_SENTENCES.R3).toBe('stamped by an unrecorded path');
    expect(DERIVED_SENTENCES.R7).toBe('unknown — before recording began');
  });

  it('speaks English, not rule ids (OCr2-14 — the chip carries the sentence)', () => {
    for (const id of RULE_IDS) expect(DERIVED_SENTENCES[id]).not.toMatch(/\bR[1-7][ab]?\b/);
  });
});

// ---------------------------------------------------------------------------
// TOTALITY — the hand table. Every combination lands on exactly one rule.
// ---------------------------------------------------------------------------

type TotalityRow = {
  name: string;
  stamps: Array<string | null>;
  events: DeriveAuditEvent[];
  ruleId: DerivedClass['ruleId'];
};

const TOTALITY: TotalityRow[] = [
  {
    name: 'stamped + source=selected',
    stamps: ['o1'],
    events: [ev({ details: { orderAttributionSource: 'selected' } })],
    ruleId: 'R1',
  },
  {
    name: 'stamped + source=reference-resolved',
    stamps: ['o1'],
    events: [ev({ details: { orderAttributionSource: 'reference-resolved' } })],
    ruleId: 'R1',
  },
  {
    name: 'stamped + adjust intent=order',
    stamps: ['o1'],
    events: [ev({ actionType: 'INVENTORY_ADJUSTMENT', details: { intent: 'order' } })],
    ruleId: 'R1b',
  },
  {
    name: 'stamped + fulfillment',
    stamps: ['o1'],
    events: [ev({ actionType: 'EXTERNAL_ORDER_FULFILLMENT', details: { orderId: 'o1' } })],
    ruleId: 'R2',
  },
  {
    name: 'stamped + partial fulfillment',
    stamps: ['o1'],
    events: [ev({ actionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT', details: { orderId: 'o1' } })],
    ruleId: 'R2',
  },
  {
    name: 'unstamped + fulfillment naming the order in details',
    stamps: [null],
    events: [ev({ actionType: 'EXTERNAL_ORDER_FULFILLMENT', details: { orderId: 'o1' } })],
    ruleId: 'R2b',
  },
  {
    name: 'unstamped + partial fulfillment naming the order by entityId',
    stamps: [null],
    events: [
      ev({ actionType: 'EXTERNAL_ORDER_PARTIAL_FULFILLMENT', entityId: 'o1', details: {} }),
    ],
    ruleId: 'R2b',
  },
  {
    name: 'stamped + selectedExternalOrderId equal to the stamp',
    stamps: ['o1'],
    events: [ev({ details: { selectedExternalOrderId: 'o1' } })],
    ruleId: 'R3a',
  },
  {
    name: 'stamped + selectedExternalOrderId naming a different order',
    stamps: ['o1'],
    events: [ev({ details: { selectedExternalOrderId: 'o2' } })],
    ruleId: 'R3',
  },
  {
    name: 'stamped + no audit event',
    stamps: ['o1'],
    events: [],
    ruleId: 'R3',
  },
  {
    name: 'stamped + a plain bulk-update event',
    stamps: ['o1'],
    events: [ev({ details: { updates: [{ productId: 1, delta: -1 }], locationId: 1 } })],
    ruleId: 'R3',
  },
  {
    name: 'MIXED stamps + no evidence',
    stamps: ['o1', 'o2'],
    events: [],
    ruleId: 'R3',
  },
  {
    name: 'PARTIALLY stamped (one row null) + no evidence',
    stamps: [null, 'o1'],
    events: [],
    ruleId: 'R3',
  },
  {
    name: 'unstamped + intent=other',
    stamps: [null],
    events: [ev({ details: { intent: 'other' } })],
    ruleId: 'R4',
  },
  {
    name: 'unstamped + intent=damage-loss + a typed reference',
    stamps: [null],
    events: [ev({ details: { intent: 'damage-loss', orderReference: '23716' } })],
    ruleId: 'R4',
  },
  {
    name: 'unstamped + a typed reference only',
    stamps: [null],
    events: [ev({ details: { orderReference: '23716' } })],
    ruleId: 'R5',
  },
  {
    name: 'unstamped + intent=order',
    stamps: [null],
    events: [ev({ details: { intent: 'order' } })],
    ruleId: 'R6',
  },
  {
    name: 'unstamped + intent=order + an accrued id (never stamped)',
    stamps: [null],
    events: [ev({ details: { intent: 'order', selectedExternalOrderId: 'o1' } })],
    ruleId: 'R6',
  },
  {
    name: 'unstamped + no audit event',
    stamps: [null],
    events: [],
    ruleId: 'R7',
  },
  {
    name: 'unstamped + a plain bulk-update event',
    stamps: [null],
    events: [ev({ details: { updates: [{ productId: 1, delta: -1 }], locationId: 1 } })],
    ruleId: 'R7',
  },
];

describe('the derivation is TOTAL', () => {
  it('covers at least 14 stamped/unstamped x event-shape combinations', () => {
    expect(TOTALITY.length).toBeGreaterThanOrEqual(14);
  });

  it.each(TOTALITY.map((row) => [row.name, row] as const))(
    'exactly one class: %s',
    (_name, row) => {
      const result = deriveHistoricalAttempt(
        batch({ stamps: row.stamps }),
        row.events,
        NO_RECORDING
      );

      expect(result.ruleId).toBe(row.ruleId);
      expect(result.sentence).toBe(DERIVED_SENTENCES[row.ruleId]);

      // The three legal (outcome, evidence, reason) shapes — an `attributed`
      // class names its evidence and no reason; the other two name a reason and
      // no evidence. A rule that returned both would be reporting two facts.
      if (result.outcome === 'attributed') {
        expect(result.evidence).toBeDefined();
        expect(result.reason).toBeUndefined();
      } else {
        expect(result.reason).toBeDefined();
        expect(result.evidence).toBeUndefined();
      }
    }
  );

  it('every rule in the table is reachable, and every reachable rule is in the table', () => {
    const covered = new Set(TOTALITY.map((row) => row.ruleId));
    expect(Array.from(covered).sort()).toEqual(
      ['R1', 'R1b', 'R2', 'R2b', 'R3', 'R3a', 'R4', 'R5', 'R6', 'R7'].sort()
    );
  });
});
