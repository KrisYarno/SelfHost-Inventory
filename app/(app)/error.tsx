"use client";

/**
 * The route-level error state (facelift F1-4). It renders inside the shell, so
 * the dock and the sidebar stay usable; the class ErrorBoundary around the
 * shell in `(app)/layout.tsx` stays for errors in the shell itself.
 */

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

export default function AppRouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="px-4 sm:px-6 py-8 max-w-xl">
      <h1 className="text-h2">Something went wrong on this page.</h1>
      <p className="mt-2 text-body-sm text-muted-foreground">Try again, or reload the app if this keeps happening. If you were saving something, check whether it went through before doing it again.</p>
      <div className="mt-4 flex gap-2">
        <Button onClick={() => reset()}>Try again</Button>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Reload
        </Button>
      </div>
    </div>
  );
}
