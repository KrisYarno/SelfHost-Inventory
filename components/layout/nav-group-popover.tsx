"use client";

/**
 * Speed-dial popover for a single {@link NavGroup} on the mobile dock.
 *
 * CONTROLLED: the parent (`mobile-nav`) owns open state so it can enforce the
 * single-open invariant (opening one group closes the others). This component
 * only reflects `isOpen` and calls `onToggle` / `onClose`.
 *
 * Behavior follows the mobile-nav-analytics-polish design doc
 * ("Design Review Resolutions 2026-06-08", AUTHORITATIVE):
 *   - Trigger: <button> with the group icon, label, and an upward chevron cue
 *     (`--nav-accent`) that rotates 180deg when open. aria-haspopup + aria-expanded.
 *   - Pills: the group's gated children rise vertically ABOVE the trigger as
 *     rounded-full <Link>s; each pill carries a solid shadow (`--dropdown-shadow`)
 *     as its separating edge + a faint `--nav-accent` glow ring on top.
 *   - Backdrop: a full-screen tap-away layer with a faint dim (~6%, tunable) + a
 *     `backdrop-blur` scoped to JUST behind the pill column (also tunable).
 *   - Edge-anchoring: align="left" left-edge-aligns, align="right" right-edge-aligns;
 *     clamped with `max-w-[calc(100vw-1rem)]` + label truncation so pills never clip.
 *   - Motion: opacity + ~8px translateY only, staggered (<=150ms total); chevron
 *     rotate <=150ms; `prefers-reduced-motion` -> instant (no transform/delay).
 *   - a11y: honest link-popover (NO role="menu"). aria-haspopup + aria-expanded on
 *     the trigger; the open container is a group of <Link>s; focus moves to the
 *     first pill on open; Tab/Shift-Tab cycle within; Esc + tap-away close and
 *     return focus to the trigger.
 */

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";
import type { NavGroup } from "@/lib/nav-config";

export interface NavGroupPopoverProps {
  group: NavGroup;
  isAdmin: boolean;
  isOpen: boolean;
  /** Toggle this group's open state (parent enforces single-open). */
  onToggle: () => void;
  /** Close this group (tap-away / Esc / post-navigation). */
  onClose: () => void;
  /**
   * Which trigger edge the rising pill column aligns to. Left-half dock slots
   * pass "left"; right-half slots pass "right" so the column never clips.
   */
  align: "left" | "right";
}

/** Stagger budget: ~35ms/pill, capped so the total entrance stays <=150ms. */
const STAGGER_STEP_MS = 35;
const STAGGER_MAX_MS = 140;

/** True when a pathname is at, or nested under, the given href. */
function routeMatches(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Tracks the user's reduced-motion preference (re-renders on change). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener?.("change", onChange);
    return () => mql.removeEventListener?.("change", onChange);
  }, []);

  return reduced;
}

export function NavGroupPopover({
  group,
  isAdmin,
  isOpen,
  onToggle,
  onClose,
  align,
}: NavGroupPopoverProps) {
  const pathname = usePathname() ?? "";
  const prefersReducedMotion = usePrefersReducedMotion();

  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const popoverRef = React.useRef<HTMLDivElement>(null);
  const firstPillRef = React.useRef<HTMLAnchorElement>(null);

  // Drives the entrance transition: pills mount at `entered=false` (off-state)
  // then flip to `true` on the next frame so opacity/translateY animate in.
  // Under reduced motion we skip the off-state entirely (instant).
  const [entered, setEntered] = React.useState(false);
  React.useEffect(() => {
    if (!isOpen) {
      setEntered(false);
      return;
    }
    if (prefersReducedMotion) {
      setEntered(true);
      return;
    }
    const raf = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(raf);
  }, [isOpen, prefersReducedMotion]);

  // Gate adminOnly children for this viewer.
  const children = React.useMemo(
    () => group.children.filter((c) => !(c.adminOnly && !isAdmin)),
    [group.children, isAdmin],
  );

  // Group is "active" when any (visible) child route is current.
  const isGroupActive = children.some((c) => routeMatches(pathname, c.href));

  // On open, move focus to the first pill. Closing returns focus to the trigger
  // (handled in the dismiss paths so navigation clicks don't yank focus back).
  React.useEffect(() => {
    if (isOpen) firstPillRef.current?.focus();
  }, [isOpen]);

  const closeAndReturnFocus = React.useCallback(() => {
    onClose();
    // Defer so the trigger is focusable after the popover unmounts.
    triggerRef.current?.focus();
  }, [onClose]);

  // Esc closes + returns focus from anywhere while open (document-level so it
  // fires regardless of which element holds focus).
  React.useEffect(() => {
    if (!isOpen) return;
    const onDocKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeAndReturnFocus();
      }
    };
    document.addEventListener("keydown", onDocKeyDown);
    return () => document.removeEventListener("keydown", onDocKeyDown);
  }, [isOpen, closeAndReturnFocus]);

  // Tab/Shift-Tab are trapped within the open popover (the container subtree).
  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Tab") return;

      const focusables = popoverRef.current?.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled])',
      );
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [],
  );

  return (
    <div className="relative flex items-center justify-center">
      {isOpen && (
        <>
          {/* Full-screen tap-away layer with a faint dim (~6%) so the pills read
              against busy content. Tunable: nudge bg-black/[0.06] up or down. */}
          <button
            type="button"
            aria-label="Dismiss menu"
            data-testid="nav-popover-backdrop"
            tabIndex={-1}
            onClick={closeAndReturnFocus}
            className="fixed inset-0 z-40 cursor-default bg-black/[0.06]"
          />

          {/* Rising pill column, anchored above the trigger. The faint
              backdrop-blur is scoped to JUST this column (the tunable knob),
              never a full-screen scrim. */}
          <div
            ref={popoverRef}
            onKeyDown={onKeyDown}
            aria-label={`${group.label} options`}
            className={cn(
              "absolute bottom-full z-50 mb-3 flex flex-col-reverse items-stretch gap-2",
              "rounded-2xl p-1 backdrop-blur-sm",
              "max-w-[calc(100vw-1rem)]",
              // Edge-anchor to the trigger; clamp keeps the column on-screen.
              align === "left" ? "left-0" : "right-0",
            )}
          >
            {children.map((child, index) => {
              const isPillActive = routeMatches(pathname, child.href);
              // Pills render bottom-up (flex-col-reverse), so the first visual
              // pill — index 0, nearest the trigger — animates first.
              const delayMs = prefersReducedMotion
                ? 0
                : Math.min(index * STAGGER_STEP_MS, STAGGER_MAX_MS);
              const Icon = child.icon;

              return (
                <Link
                  key={child.href}
                  ref={index === 0 ? firstPillRef : undefined}
                  href={child.href}
                  onClick={onClose}
                  aria-current={isPillActive ? "page" : undefined}
                  style={
                    prefersReducedMotion
                      ? undefined
                      : { transitionDelay: `${delayMs}ms` }
                  }
                  className={cn(
                    "group/pill flex min-h-[44px] items-center gap-2 self-end",
                    "rounded-full bg-popover px-3 py-2 pr-4",
                    "text-sm font-medium text-foreground",
                    // Solid drop shadow = the separating edge; soft --nav-accent
                    // glow on top, plus a thicker accent ring as the pill border.
                    "shadow-[var(--dropdown-shadow),0_0_16px_2px_hsl(var(--nav-accent)/0.4)]",
                    "ring-2 ring-[hsl(var(--nav-accent)/0.4)]",
                    "transition-[opacity,transform] duration-150 ease-out",
                    // Entrance: opacity + ~8px translateY only (no scale/bounce).
                    entered ? "translate-y-0 opacity-100" : "translate-y-2 opacity-0",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
                    "hover:bg-surface-hover",
                    isPillActive && "text-primary ring-[hsl(var(--nav-accent)/0.6)]",
                  )}
                >
                  <span
                    className={cn(
                      "flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                      "bg-surface-hover text-foreground",
                      isPillActive && "bg-primary/15 text-primary",
                    )}
                  >
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <span className="truncate">{child.label}</span>
                </Link>
              );
            })}
          </div>
        </>
      )}

      {/* Trigger */}
      <button
        ref={triggerRef}
        type="button"
        onClick={onToggle}
        aria-haspopup="true"
        aria-expanded={isOpen}
        aria-current={isGroupActive ? "true" : undefined}
        aria-label={group.label}
        title={group.label}
        className={cn(
          // z-50 keeps the trigger ABOVE the open dismiss-backdrop (z-40) so a
          // tap on another group's trigger switches groups instead of being
          // eaten by the backdrop; page taps still fall through to dismiss.
          "relative z-50 flex min-h-[44px] min-w-[44px] flex-col items-center justify-center rounded-lg p-2",
          "transition-colors",
          "hover:bg-muted/50 active:bg-muted",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
          isGroupActive ? "text-primary" : "text-muted-foreground",
        )}
      >
        {/* Icon bubble; gets the --nav-accent glowing ring when this group is open. */}
        <span
          className={cn(
            "relative flex h-6 w-6 items-center justify-center rounded-full transition-shadow",
            isOpen && "shadow-[0_0_0_2px_hsl(var(--nav-accent)/0.6),0_0_10px_2px_hsl(var(--nav-accent)/0.35)]",
          )}
        >
          <group.icon
            className={cn("h-5 w-5", isGroupActive && "scale-110")}
            aria-hidden="true"
          />
        </span>

        <span className="mt-1 flex items-center gap-0.5 text-[10px] leading-none">
          {group.label}
          <ChevronUp
            className={cn(
              "h-3 w-3 text-[hsl(var(--nav-accent))] transition-transform duration-150 ease-out",
              isOpen ? "rotate-180" : "rotate-0",
            )}
            aria-hidden="true"
          />
        </span>

        {/* Active dot (matches the dock's direct-link treatment). */}
        {isGroupActive && (
          <span className="absolute bottom-0 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full bg-primary" />
        )}
      </button>
    </div>
  );
}
