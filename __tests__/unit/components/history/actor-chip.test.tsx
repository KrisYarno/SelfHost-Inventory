/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 2 — ActorChip (spec §11 D-L5): USER renders plain text with no
 * badge; non-USER actors (SYSTEM/WEBHOOK/LLM) render a badge with an icon.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { ActorChip } from '@/components/history/actor-chip';

describe('ActorChip', () => {
  it('renders a USER actor as plain text with no icon badge', () => {
    const { container } = render(<ActorChip actorKind="USER" actorName="alice" />);
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });

  it('renders a SYSTEM actor as a badge with an icon', () => {
    const { container } = render(<ActorChip actorKind="SYSTEM" actorName={null} />);
    expect(screen.getByText(/system/i)).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders a WEBHOOK actor as a badge with an icon', () => {
    const { container } = render(<ActorChip actorKind="WEBHOOK" actorName={null} />);
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('renders an LLM actor as a badge with an icon', () => {
    const { container } = render(<ActorChip actorKind="LLM" actorName="Assistant" />);
    expect(screen.getByText('Assistant')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('falls back to a plain-text label for a USER with no name', () => {
    const { container } = render(<ActorChip actorKind="USER" actorName={null} />);
    // still text, still no badge icon
    expect(container.querySelector('svg')).toBeNull();
    expect(container.textContent).toBeTruthy();
  });
});
