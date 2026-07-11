/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 2 — LedgerRowLine (spec §11 D-L5): ValueChip signed delta +
 * exactly ONE StatusBadge (logType via getInventoryLogTone) + plain-text
 * reason/location/cost; unassigned caption.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { LedgerRowLine } from '@/components/history/ledger-row-line';
import type { RenderableLedgerRow } from '@/lib/history/union-timeline';

const row = (over: Partial<RenderableLedgerRow> = {}): RenderableLedgerRow => ({
  id: 1,
  ts: '2026-07-10T12:00:00.000Z',
  delta: -3,
  logType: 'SALE',
  reasonCode: null,
  unitCostCents: null,
  locationName: null,
  transferId: null,
  userName: null,
  ...over,
});

describe('LedgerRowLine', () => {
  it('renders the signed delta in a ValueChip', () => {
    render(<LedgerRowLine row={row({ delta: -3 })} />);
    expect(screen.getByTestId('ledger-delta-chip')).toHaveTextContent('-3');
  });

  it('renders a positive delta with a leading +', () => {
    render(<LedgerRowLine row={row({ delta: 5, logType: 'STOCK_IN' })} />);
    expect(screen.getByTestId('ledger-delta-chip')).toHaveTextContent('+5');
  });

  it('renders exactly ONE logType StatusBadge with the human label', () => {
    render(<LedgerRowLine row={row({ logType: 'SALE' })} />);
    const badges = screen.getAllByTestId('ledger-logtype-badge');
    expect(badges).toHaveLength(1);
    expect(badges[0]).toHaveTextContent('Sale');
  });

  it('renders reason, location and cost as plain text', () => {
    render(
      <LedgerRowLine
        row={row({
          reasonCode: 'DAMAGE',
          locationName: 'Warehouse A',
          unitCostCents: 150,
          logType: 'ADJUSTMENT',
          delta: -2,
        })}
      />,
    );
    expect(screen.getByText('DAMAGE')).toBeInTheDocument();
    expect(screen.getByText('Warehouse A')).toBeInTheDocument();
    expect(screen.getByText('$1.50')).toBeInTheDocument();
    // reason/location/cost are NOT extra badges — only the one logType badge.
    expect(screen.getAllByTestId('ledger-logtype-badge')).toHaveLength(1);
  });

  it('renders the unassigned caption when unassigned', () => {
    render(<LedgerRowLine row={row()} unassigned />);
    expect(screen.getByText(/not linked to a recorded event/i)).toBeInTheDocument();
  });

  it('does not render the unassigned caption by default', () => {
    render(<LedgerRowLine row={row()} />);
    expect(screen.queryByText(/not linked to a recorded event/i)).not.toBeInTheDocument();
  });
});
