"use client";

import { useEffect, useState } from "react";

/**
 * Reactive media-query hook. SSR returns `defaultMatch` so the first paint
 * matches a known viewport (defaults to true for the `lg+` case so server
 * markup matches a desktop layout, then the client may switch to mobile
 * after mount without a hydration warning).
 */
export function useMediaQuery(query: string, defaultMatch = true): boolean {
  const [matches, setMatches] = useState(defaultMatch);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

export function useIsDesktop(): boolean {
  return useMediaQuery("(min-width: 1024px)", true);
}
