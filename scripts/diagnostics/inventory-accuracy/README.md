# inventory-accuracy — Phase 0a diagnostic suite (READ-ONLY)

The diagnostic half of the inventory-accuracy lane. Spec:
`docs/superpowers/specs/2026-08-12-inventory-accuracy-phase0-spec.md` (REV-2, §Phase 0a).
Brief: `docs/superpowers/2026-08-12-inventory-accuracy-lane-brief.md`.

Every module issues SELECTs and nothing else. There is no write path here: no
`$executeRaw`, no model mutations, no migrations, no service lifecycle. It is meant to be
run **by the orchestrator** against a StagingProduction restore of a **fresh** prod dump.
The output (JSON + text per check) is what the committed diagnosis report is written from.

## Invocation

```bash
DATABASE_URL='mysql://USER:PASS@HOST:3306/DBNAME' \
  node scripts/diagnostics/inventory-accuracy/run.js \
    --out=/absolute/path/to/artifact-dir \
    --checks=d1,d2,d3,d4 \
    --window-days=90 \
    --snapshot-window-days=90 \
    --top=50 \
    --order-rows=200 \
    --census-since=2026-07-14 \
    --class-b-floor=evidence
```

Only `--out` is required; everything else defaults to the values shown. The runner prints
the connection's **host and database only** — credentials are never printed or written.

Artifacts written: `d1-reconciliation.{json,txt}`, `d2-inbound.{json,txt}`,
`d3-snapshot-walk.{json,txt}`, `d4-checks.{json,txt}`, plus `index.json` (run metadata,
options, per-check status and durations).

`--class-b-floor` chooses which observability floor **binds** for evidence class (b); both
readings are always emitted side by side. See "Declared deviations" below. It accepts
exactly `evidence` or `spec` — anything else is a **validation error**, never coerced (a
typo'd flag must not quietly bind a different reading).

## What each check answers

| Check | Question |
| --- | --- |
| `d1-reconciliation` | Per (order, product): units Woo observed on a completed order vs NET units the ledger removed for that order. Statuses `full/partial/none/over/unobservable` with unit differences. Plus three supplemental panels: the **over-cohort split**, the **line-grain observed-vs-fulfilledQty** panel (full history), and the **unattributed outbound pool**. |
| `d2-inbound` | Largest positive-adjustment batches in a trailing window (actor, location, batch id) + identification of mass-update operations as overwrite/count-event dates. Includes negative-correction mass batches. |
| `d3-snapshot-walk` | Per (product, location, day): snapshot delta vs ledger delta. Coverage gaps disclosed, never interpolated. |
| `d4-checks` | Legacy `products.quantity` mirror gap; logType census by ISO week; `stockedOut` set-rate over time. |

## Disciplines encoded in the code

- **PII.** Projections are ids, counts, dates, quantities and status/enum fields only.
  Customer fields, addresses, raw platform payloads and notes bodies are never selected.
  Actor **user ids** are projected; names and emails are not — map ids offline. Company,
  integration, location and product **names** are deliberately not projected either.
- **`audit_logs.details`** is touched through exactly two narrow paths: `JSON_CONTAINS_PATH`
  predicates for the D2 mass-update shape discriminator, and `$.orderReference` extraction
  for evidence class (c). Nothing else is projected out of it.
- **Truthful data.** A structurally-unpopulated slot is `null` plus a named reason, never
  `0`. `figure()` throws without a definition string; `emptySlot()` throws without a reason.
- **Disclosures ride with the number.** Unobservable counts, coverage gaps and ambiguous
  matches are properties of the figure they qualify, not footnotes.
- **Unavailable is never a gap.** Orders anchored before every applicable evidence class's
  start are `historically_unobservable`: excluded from gap totals, disclosed with a reason.
  Every excluded cohort carries a **unit count beside its order count**, so an exclusion is
  never an order count with no magnitude.
- **Evidence that contradicts itself is dropped, not resolved.** A `batchId` claimed by two
  orders is dropped from **both** attributions (never first-wins), in either evidence
  class. Its ledger units land in the unattributed outbound pool instead.

## D1's three supplemental panels

- **Over-cohort split.** `unitsOnCompletedOrder` is 0 for every Woo status but `completed`,
  and the app's completed-push is expected-blocked in production — so an order the app
  fulfilled and deducted can sit non-completed at Woo *permanently* and read as
  over-deduction by construction. `over` is therefore split into **over on a completed
  order** (the only evidence-backed reading, the whole of `unitsOverDeducted`) and
  **deducted, order not completed** (excluded from gap totals, with its own order count,
  unit count, named reason and detail table).
- **Line-grain observed-vs-fulfilledQty.** Per (order, product): `external_order_items`
  `quantity`/`fulfilledQty` against observation units, with **no ledger join and no
  observability floor** — the only panel covering the full history, so it is the only one
  that can date pre-July drift. Rolled up by the order's anchor month (UTC). **Caveat,
  binding:** `fulfilledQty` is written only by the app's own fulfill path, so a zero means
  "not fulfilled *through this app*", never "not shipped". Bundle and unmapped lines are
  excluded and counted (a bundle line's quantity is line grain; its observations are
  component grain).
- **Unattributed outbound pool.** Negative-delta `SALE` units (and, separately, negative
  `ADJUSTMENT` units) in the post-floor window that no evidence class reached. It
  upper-bounds how much of the under-deduction gap could be *unlinked* rather than
  *missing*, and the confound rides on `gapTotals.unitsUnderDeducted` itself.

## Declared deviations from the frozen spec (details in the Phase 0a SEAMS report)

1. **Class (b) floor.** The spec freezes "class b starts at the stockedOut feature's
   deploy" (2026-04-11). But class (b) evidence is the ledger↔audit `batchId` join, and
   `inventory_logs.batchId` only exists from `20260710150000` with the
   `EXTERNAL_ORDER_*FULFILLMENT` action types from `20260709164143`. The literal floor
   would score months of orders as gaps for evidence that could not have been recorded, so
   the default binds the **evidence-capable** floor (the later of the three components) and
   emits the literal one alongside. `--class-b-floor=spec` binds the literal reading.
2. **D2 `>500`-row mass updates.** The frozen discriminator is the `details.rows` audit
   shape, but `app/api/admin/inventory/mass-update/route.ts` replaces `rows` with
   `rowCount` + `rowsOmitted` above 500 rows. Those operations are identified separately by
   the `rowsOmitted` shape and labelled as such, so the frozen rule stays visible.
   **Phase 0b-1 adds a second branch** (`lib/mass-update.js`, both branches named per batch
   in the `identifiedBy` column): the route now stamps `logType: COUNT`, which no other
   writer emits, so operations from that deploy on are identified by the LEDGER — including
   `>500`-row ones (a full identification, not the degraded case) and ones whose
   best-effort audit summary never landed (`recordIngestion`, P-B1), which the audit-shape
   rule cannot see at all. Batches written BEFORE the deploy carry no `COUNT` rows and are
   still identified by the frozen rule alone.
3. **D3 framing.** `product_stock_snapshots` levels are RECONSTRUCTED from the ledger
   (`lib/analytics/rebuild-snapshots.ts`), so a divergence is evidence about the rebuild —
   not proof of an out-of-band stock write. The check runs exactly as specified; the
   interpretation disclosure rides on every D3 figure.
4. **`$.selectedExternalOrderId`** (added by Phase 0b-2) is direct-id evidence with no
   frozen class in 0a. It is **counted and not used**, recorded for the full-lane design.

## Tests

`__tests__/unit/scripts/diagnostics/inventory-accuracy-classify.test.js` pins the pure
logic (floors, evidence-class assignment, normalization, ambiguity, statuses, the over
split, the attribution munging in `lib/attribute.js`, the rollups in `lib/rollups.js`, the
mass-update discriminator in `lib/mass-update.js`, the snapshot walk, the artifact house
rules and the runner's argv). The SQL runs only against the real restore — it is not
exercised by the unit suite.

```bash
node scripts/test-runner.js __tests__/unit/scripts/diagnostics/inventory-accuracy-classify.test.js
```
