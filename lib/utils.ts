import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"
import { format } from "date-fns"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num)
}

/** House log-timestamp mask (desktop tables). */
export function formatDateTime(d: Date | string | number): string {
  return format(new Date(d), "MMM dd, yyyy HH:mm");
}

/** Compact log-timestamp mask (mobile cards). */
export function formatShortDateTime(d: Date | string | number): string {
  return format(new Date(d), "MMM dd, HH:mm");
}

/** Signed delta for inventory changes: +3 / -2 / 0. */
export function formatDelta(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}