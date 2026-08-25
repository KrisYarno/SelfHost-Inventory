// Top-level directive
"use client";

/**
 * app/(app)/admin/reconciliation/page.tsx — the reconciliation surface (pack
 * C4a.1; spec REV-7 §7).
 *
 * Admin-only is enforced by `app/(app)/admin/layout.tsx` (server `getSession()`
 * + redirect), and every route behind this page is independently
 * `requireAdmin()`-gated. The page itself is the mount point; the tabs, the
 * `?tab=` sync and the content live in the shell.
 */

import { ReconciliationPageShell } from "@/components/admin/reconciliation/page-shell";

export default function AdminReconciliationPage() {
  return <ReconciliationPageShell />;
}
