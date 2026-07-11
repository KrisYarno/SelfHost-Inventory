/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 2 — ChangeDiffList (spec §11 D-L5): core-change-first, +N more
 * disclosure, aria-expanded, whole primary line clickable, [REDACTED] verbatim.
 */
import React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChangeDiffList } from '@/components/history/change-diff-list';
import type { ChangePair } from '@/lib/change-tracking/extract-changes';

const pair = (from: unknown, to: unknown): ChangePair => ({ from, to });

describe('ChangeDiffList', () => {
  it('renders the core change first (priority table beats insertion order)', () => {
    render(
      <ChangeDiffList
        changes={{ retailPrice: pair(1, 2), name: pair('a', 'b') }}
        entityHint="PRODUCT"
      />,
    );
    // Collapsed by default: only the core (highest-priority) field shows.
    const primary = screen.getByRole('button');
    expect(within(primary).getByText('name')).toBeInTheDocument();
    // The lower-priority field is collapsed away until expanded.
    expect(screen.queryByText('retailPrice')).not.toBeInTheDocument();
  });

  it('shows a "+N more changes" affordance only when there is more than one field', () => {
    const { rerender } = render(
      <ChangeDiffList changes={{ name: pair('a', 'b') }} entityHint="PRODUCT" />,
    );
    expect(screen.queryByText(/more changes/i)).not.toBeInTheDocument();
    // No disclosure button for a single change.
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <ChangeDiffList
        changes={{ name: pair('a', 'b'), quantity: pair(5, 6), unit: pair('EA', 'BOX') }}
        entityHint="PRODUCT"
      />,
    );
    expect(screen.getByText(/\+2 more changes/i)).toBeInTheDocument();
  });

  it('toggles aria-expanded and reveals the collapsed fields when the primary line is clicked', async () => {
    const user = userEvent.setup();
    render(
      <ChangeDiffList
        changes={{ name: pair('a', 'b'), quantity: pair(5, 6) }}
        entityHint="PRODUCT"
      />,
    );
    const primary = screen.getByRole('button');
    expect(primary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('quantity')).not.toBeInTheDocument();

    // Whole primary line is the clickable control.
    await user.click(primary);
    expect(primary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('quantity')).toBeInTheDocument();
  });

  it('renders a [REDACTED] value verbatim', () => {
    render(
      <ChangeDiffList
        changes={{ passwordHash: pair('[REDACTED]', '[REDACTED]') }}
        entityHint="USER"
      />,
    );
    expect(screen.getAllByText('[REDACTED]').length).toBeGreaterThan(0);
  });

  it('renders the from→to values with the → glyph', () => {
    render(
      <ChangeDiffList changes={{ quantity: pair(5, 8) }} entityHint="INVENTORY" />,
    );
    expect(screen.getByText('5')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
    expect(screen.getByText('→')).toBeInTheDocument();
  });

  it('renders nothing for an empty change set', () => {
    const { container } = render(<ChangeDiffList changes={{}} entityHint="PRODUCT" />);
    expect(container).toBeEmptyDOMElement();
  });
});
