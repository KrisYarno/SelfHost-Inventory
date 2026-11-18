import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * The not-found state for authenticated pages (facelift F1-4). It renders
 * inside the shell: `[...missing]/page.tsx` sends every unmatched URL here.
 */
export default function AppRouteNotFound() {
  return (
    <div className="px-4 sm:px-6 py-8 max-w-xl">
      <h1 className="text-h2">This page doesn&apos;t exist.</h1>
      <div className="mt-4 flex gap-2">
        <Button asChild>
          <Link href="/workbench">Go to the workbench</Link>
        </Button>
      </div>
    </div>
  );
}
