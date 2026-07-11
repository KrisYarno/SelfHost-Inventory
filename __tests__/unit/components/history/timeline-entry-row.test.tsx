/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 2 — TimelineEntryRow (spec §11 D-L5): batch chip drill-down,
 * restricted-event stub (R-L5), 0-field supporting line, orphan-kind labels,
 * nested-movement disclosure, exact-ms title on the relative time.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TimelineEntryRow } from '@/components/history/timeline-entry-row';
import { actionMeta } from '@/lib/change-tracking/taxonomy';
import type {
  TimelineEntry,
  RenderableAuditEvent,
  RenderableLedgerRow,
} from '@/lib/history/union-timeline';

const TS = '2026-07-10T12:00:00.000Z';

const evt = (over: Partial<RenderableAuditEvent> = {}): RenderableAuditEvent => ({
  id: 1,
  ts: TS,
  actionType: 'PRODUCT_UPDATE',
  meta: actionMeta('PRODUCT_UPDATE'),
  actorKind: 'USER',
  actorName: 'alice',
  action: 'Updated product',
  changes: null,
  snapshotFieldCount: null,
  cascadeCount: null,
  bulkRowCount: null,
  batchId: null,
  affectedCount: 1,
  restricted: false,
  ...over,
});

const ledgerRow = (over: Partial<RenderableLedgerRow> = {}): RenderableLedgerRow => ({
  id: 10,
  ts: TS,
  delta: -3,
  logType: 'SALE',
  reasonCode: null,
  unitCostCents: null,
  locationName: null,
  transferId: null,
  userName: null,
  ...over,
});

const eventEntry = (
  event: RenderableAuditEvent,
  ledgerRows: RenderableLedgerRow[] = [],
  unassignedRows: RenderableLedgerRow[] = [],
): TimelineEntry => ({ kind: 'event', ts: event.ts, event, ledgerRows, unassignedRows });

describe('TimelineEntryRow', () => {
  it('fires onBatchClick with the batchId when the batch chip is clicked', async () => {
    const user = userEvent.setup();
    const onBatchClick = jest.fn();
    render(
      <TimelineEntryRow
        entry={eventEntry(evt({ batchId: 'batch-xyz' }))}
        onBatchClick={onBatchClick}
      />,
    );
    const chip = screen.getByRole('button', { name: /view batch/i });
    await user.click(chip);
    expect(onBatchClick).toHaveBeenCalledWith('batch-xyz');
  });

  it('renders a restricted event as the stub with no diff content (R-L5)', () => {
    render(
      <TimelineEntryRow
        entry={eventEntry(
          evt({
            actionType: 'EXTERNAL_ORDER_FULFILLMENT',
            meta: actionMeta('EXTERNAL_ORDER_FULFILLMENT'),
            restricted: true,
            changes: null,
            action: 'Order fulfillment — company-scoped',
          }),
        )}
      />,
    );
    expect(screen.getByText(/company-scoped/i)).toBeInTheDocument();
    // No field-diff rendered.
    expect(screen.queryByText('→')).not.toBeInTheDocument();
  });

  it('renders only the supporting line for a 0-field change event', () => {
    render(<TimelineEntryRow entry={eventEntry(evt({ changes: null, action: 'Product approved' }))} />);
    expect(screen.getByText(/Product approved/i)).toBeInTheDocument();
    expect(screen.queryByText('→')).not.toBeInTheDocument();
  });

  it('renders the core change diff when changes are present', () => {
    render(
      <TimelineEntryRow
        entry={eventEntry(evt({ changes: { quantity: { from: 5, to: 8 } } }))}
      />,
    );
    expect(screen.getByText('→')).toBeInTheDocument();
    expect(screen.getByText('quantity')).toBeInTheDocument();
  });

  it('puts the exact ms ISO timestamp in the title attribute', () => {
    render(<TimelineEntryRow entry={eventEntry(evt())} />);
    expect(screen.getByTitle(TS)).toBeInTheDocument();
  });

  it('collapses nested movements by default and reveals them via the disclosure', async () => {
    const user = userEvent.setup();
    render(
      <TimelineEntryRow
        entry={eventEntry(evt({ batchId: 'b1' }), [ledgerRow({ id: 10 }), ledgerRow({ id: 11 })])}
      />,
    );
    expect(screen.queryAllByTestId('ledger-delta-chip')).toHaveLength(0);
    const toggle = screen.getByRole('button', { name: /movements/i });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('ledger-delta-chip')).toHaveLength(2);
  });

  it('renders nested movements immediately when defaultExpanded', () => {
    render(
      <TimelineEntryRow
        entry={eventEntry(evt({ batchId: 'b1' }), [ledgerRow({ id: 10 })])}
        defaultExpanded
      />,
    );
    expect(screen.getAllByTestId('ledger-delta-chip')).toHaveLength(1);
  });

  it('renders unassigned rows with the not-linked caption', () => {
    render(
      <TimelineEntryRow
        entry={eventEntry(evt({ batchId: 'b1' }), [], [ledgerRow({ id: 20 })])}
        defaultExpanded
      />,
    );
    expect(screen.getByText(/not linked to a recorded event/i)).toBeInTheDocument();
  });

  it('labels a legacy-unlinked orphan ledger entry distinctly from a missing-summary orphan', () => {
    const legacy: TimelineEntry = {
      kind: 'ledger',
      ts: TS,
      ledgerRows: [ledgerRow({ id: 30 })],
      orphanKind: 'legacy-unlinked',
    };
    const missing: TimelineEntry = {
      kind: 'ledger',
      ts: TS,
      ledgerRows: [ledgerRow({ id: 31 })],
      orphanKind: 'missing-summary-event',
    };

    const { unmount } = render(<TimelineEntryRow entry={legacy} />);
    const legacyLabel = screen.getByTestId('orphan-label').textContent;
    unmount();

    render(<TimelineEntryRow entry={missing} />);
    const missingLabel = screen.getByTestId('orphan-label').textContent;

    expect(legacyLabel).toBeTruthy();
    expect(missingLabel).toBeTruthy();
    expect(legacyLabel).not.toEqual(missingLabel);
  });

  it('renders orphan ledger rows inline (always visible, no disclosure)', () => {
    const legacy: TimelineEntry = {
      kind: 'ledger',
      ts: TS,
      ledgerRows: [ledgerRow({ id: 30, delta: 4, logType: 'STOCK_IN' })],
      orphanKind: 'legacy-unlinked',
    };
    render(<TimelineEntryRow entry={legacy} />);
    expect(screen.getByTestId('ledger-delta-chip')).toHaveTextContent('+4');
  });
});
