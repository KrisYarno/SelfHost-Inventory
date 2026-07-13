/**
 * @jest-environment jsdom
 *
 * Lane 3 Task 2 — ActorChip (spec §11 D-L5): USER renders plain text with no
 * badge; non-USER actors (SYSTEM/WEBHOOK/LLM) render a badge with an icon.
 *
 * Lane 4 trunk amendment (Lane 4 spec §3 D9): a non-USER chip ALWAYS renders
 * its kind label ("Assistant"), never the resolved username; the approving
 * human surfaces via the separate allowlisted `detail` prop, appended muted
 * ("Assistant · approved by kris").
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

  // ------------------------------------------------------------------
  // Lane 4 D9 amendment: kind label always wins for non-USER actors
  // ------------------------------------------------------------------

  it('renders the kind label for an LLM actor even when a username is resolved (D9)', () => {
    render(<ActorChip actorKind="LLM" actorName="kris" />);
    expect(screen.getByText('Assistant')).toBeInTheDocument();
    expect(screen.queryByText('kris')).not.toBeInTheDocument();
  });

  it('renders the kind label for SYSTEM/WEBHOOK actors even when a username is resolved (D9)', () => {
    const { unmount } = render(<ActorChip actorKind="SYSTEM" actorName="kris" />);
    expect(screen.getByText('System')).toBeInTheDocument();
    expect(screen.queryByText('kris')).not.toBeInTheDocument();
    unmount();

    render(<ActorChip actorKind="WEBHOOK" actorName="kris" />);
    expect(screen.getByText('Webhook')).toBeInTheDocument();
    expect(screen.queryByText('kris')).not.toBeInTheDocument();
  });

  it('renders the raw kind (never the username) for an unknown non-USER kind', () => {
    render(<ActorChip actorKind="CRON" actorName="kris" />);
    expect(screen.getByText('CRON')).toBeInTheDocument();
    expect(screen.queryByText('kris')).not.toBeInTheDocument();
  });

  it('appends the detail muted after the badge ("Assistant · approved by kris")', () => {
    const { container } = render(
      <ActorChip actorKind="LLM" actorName="kris" detail="approved by kris" />,
    );
    expect(screen.getByText('Assistant')).toBeInTheDocument();
    const detail = screen.getByText(/approved by kris/);
    expect(detail).toBeInTheDocument();
    expect(detail.className).toContain('text-muted-foreground');
    // reads "Assistant · approved by kris"
    expect(container.textContent).toMatch(/Assistant\s*·\s*approved by kris/);
  });

  it('renders no detail text when the detail prop is absent', () => {
    render(<ActorChip actorKind="LLM" actorName={null} />);
    expect(screen.queryByText(/approved by/)).not.toBeInTheDocument();
  });

  it('ignores the detail prop on the USER path (unchanged rendering)', () => {
    const { container } = render(
      <ActorChip actorKind="USER" actorName="alice" detail="approved by kris" />,
    );
    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(screen.queryByText(/approved by/)).not.toBeInTheDocument();
    expect(container.querySelector('svg')).toBeNull();
  });
});
