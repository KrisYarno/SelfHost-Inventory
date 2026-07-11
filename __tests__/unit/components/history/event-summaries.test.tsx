/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 2 — EventSummaries (spec §11 D-L5 / D4): the snapshot/cascade/bulk
 * one-liner. Renders only the counts that are present; nothing when all null.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { EventSummaries } from '@/components/history/event-summaries';

describe('EventSummaries', () => {
  it('renders the captured-fields count (plural)', () => {
    render(
      <EventSummaries snapshotFieldCount={5} cascadeCount={null} bulkRowCount={null} />,
    );
    expect(screen.getByText(/Captured 5 fields/i)).toBeInTheDocument();
  });

  it('renders the captured-fields count (singular)', () => {
    render(
      <EventSummaries snapshotFieldCount={1} cascadeCount={null} bulkRowCount={null} />,
    );
    expect(screen.getByText(/Captured 1 field/i)).toBeInTheDocument();
    expect(screen.queryByText(/1 fields/i)).not.toBeInTheDocument();
  });

  it('renders the cascade child count', () => {
    render(
      <EventSummaries snapshotFieldCount={null} cascadeCount={3} bulkRowCount={null} />,
    );
    expect(screen.getByText(/Cascaded 3 children/i)).toBeInTheDocument();
  });

  it('renders the bulk row count', () => {
    render(
      <EventSummaries snapshotFieldCount={null} cascadeCount={null} bulkRowCount={12} />,
    );
    expect(screen.getByText(/12 rows/i)).toBeInTheDocument();
  });

  it('renders nothing when every count is null', () => {
    const { container } = render(
      <EventSummaries snapshotFieldCount={null} cascadeCount={null} bulkRowCount={null} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when counts are zero', () => {
    const { container } = render(
      <EventSummaries snapshotFieldCount={0} cascadeCount={0} bulkRowCount={0} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
