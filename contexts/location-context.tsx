'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { Location } from '@prisma/client';

/** Where the chosen location is remembered between visits. */
const SELECTED_LOCATION_KEY = 'selectedLocationId';

interface LocationContextType {
  locations: Location[];
  /**
   * Facelift FR1-1: the selected location, ONLY once a successful read has
   * confirmed it is in the list. A saved id is never handed out on its own:
   * while the list is loading, or its first read failed, every consumer — and
   * so every stock write — sees `null`.
   */
  selectedLocation: Location | null;
  /** `selectedLocation?.id ?? null`: a confirmed id, or none (FR1-1). */
  selectedLocationId: number | null;
  setSelectedLocationId: (locationId: number) => void;
  isLoading: boolean;
  /**
   * Facelift F0 FR1-3: the last `/api/locations` read answered non-ok or threw
   * (cleared by a successful one). A failed read is not "no locations": an empty
   * `locations` with this set means UNKNOWN, never none configured.
   */
  loadFailed: boolean;
  /** Reads `/api/locations` again (FR1-3). */
  retryLocations: () => void;
}

const LocationContext = createContext<LocationContextType | undefined>(undefined);

export function LocationProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const [locations, setLocations] = useState<Location[]>([]);
  // Facelift FR1-1: the id the rules work on — restored from localStorage,
  // chosen on the chip, or picked on a first visit. It stays INTERNAL: what
  // consumers get is `selectedLocationId` below, the same id only once a
  // successful read has it in the list.
  const [rawLocationId, setRawLocationId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped by `retryLocations` to run the fetch below again.
  const [reloadKey, setReloadKey] = useState(0);
  const defaultLocationId = session?.user?.defaultLocationId ?? null;
  // Facelift FR2-3 (FD1-3): the read below is keyed on WHO is signed in, not on
  // the session object — `SessionProvider` hands out a new one on every tab
  // focus, and each one re-read the list on the shared per-IP bucket.
  const userId = session?.user?.id ?? null;
  // Facelift F1-5 / FR1-2: set when a saved id was discarded. The selection
  // then stays empty — the chip asks — until the user chooses; a later read
  // never fills it in on their behalf.
  const awaitingChoiceRef = useRef(false);
  // Set once a stale id's discard has been announced, until an id is kept: the
  // warning shows ONCE per discard.
  const staleWarnedRef = useRef(false);
  // Facelift FR3-2: the read below makes the first-visit pick, and its deps stay
  // `[userId, reloadKey]` — so it reads the user's default through a ref.
  const defaultLocationIdRef = useRef(defaultLocationId);
  useEffect(() => {
    defaultLocationIdRef.current = defaultLocationId;
  }, [defaultLocationId]);

  // Fetch locations once per signed-in user (FR2-3), and again on Retry. A
  // location added elsewhere shows after a reload or a Retry; one deleted
  // elsewhere is refused by the server and discarded at the next read.
  //
  // Facelift FR3-2 (QA-1): a successful read sets the list AND the first-visit
  // pick in the same batch, so no render hands consumers a loaded list with
  // nothing selected — a consumer that decides once when the list resolves
  // (the Fulfill dialog's seed) decided on that render, and seeded nothing.
  // Only an EMPTY selection is filled: a restored saved id is kept, and the
  // rules below confirm or discard it as before; a discarded id, while the chip
  // asks, is never filled in. The rules stay the backstop.
  useEffect(() => {
    // Nothing saved: the user's default when it is in the list, otherwise the
    // first location (F1-5).
    const firstVisitPick = (list: Location[]) => {
      const preferred = defaultLocationIdRef.current;
      if (preferred !== null && list.some((loc) => loc.id === preferred)) return preferred;
      return list[0]?.id ?? null;
    };

    async function fetchLocations() {
      try {
        const response = await fetch('/api/locations');
        if (response.ok) {
          const data: Location[] = await response.json();
          setLocations(data);
          setLoadFailed(false);
          setRawLocationId((cur) => cur ?? (awaitingChoiceRef.current ? null : firstVisitPick(data)));
        } else {
          setLoadFailed(true);
        }
      } catch (error) {
        console.error('Failed to fetch locations:', error);
        setLoadFailed(true);
      } finally {
        setIsLoading(false);
      }
    }

    if (userId !== null) {
      fetchLocations();
    }
  }, [userId, reloadKey]);

  // FR2-4: with no signed-in user the effect above fetches nothing, so a retry
  // then would set `isLoading` with no read to clear it. It does nothing instead.
  const retryLocations = useCallback(() => {
    if (userId === null) return;
    setIsLoading(true);
    setReloadKey((key) => key + 1);
  }, [userId]);

  // Facelift F1-5 — which location every stock write targets. The rules run on
  // every SUCCESSFUL read, and never against a loading or failed one: a failed
  // refresh over a loaded list changes nothing, and a failed first read leaves
  // the saved id alone (unpublished — FR1-1).
  //   - empty list: nothing is selected, and the saved id is removed;
  //   - a current id in the list: kept;
  //   - a current id NOT in the list (stale): discarded for NOTHING — the chip
  //     asks, and a warning says so ONCE. A discarded id never becomes a write
  //     target on its own: not the user's default, not the first location
  //     (FR1-2, reversing REV 4 (A));
  //   - nothing saved (first visit): the default when it is in the list,
  //     otherwise the first location. The read above already made this pick
  //     with its answer (FR3-2); here it is the backstop.
  // The updaters only apply to the id the decision was made about, so a choice
  // the user made in between is never overwritten.
  useEffect(() => {
    if (isLoading || loadFailed) return;

    if (locations.length === 0) {
      awaitingChoiceRef.current = false;
      staleWarnedRef.current = false;
      setRawLocationId(null);
      localStorage.removeItem(SELECTED_LOCATION_KEY);
      return;
    }

    const inList = (id: number | null) => id !== null && locations.some((loc) => loc.id === id);

    if (rawLocationId === null) {
      if (awaitingChoiceRef.current) return;
      const first = (inList(defaultLocationId) ? defaultLocationId : null) ?? locations[0].id;
      setRawLocationId((current) => (current === null ? first : current));
      return;
    }

    if (inList(rawLocationId)) {
      awaitingChoiceRef.current = false;
      staleWarnedRef.current = false;
      return;
    }

    if (!staleWarnedRef.current) {
      staleWarnedRef.current = true;
      toast.warning('Your saved location is no longer available. Choose a location.');
    }
    awaitingChoiceRef.current = true;
    const discarded = rawLocationId;
    setRawLocationId((current) => (Object.is(current, discarded) ? null : current));
  }, [locations, isLoading, loadFailed, rawLocationId, defaultLocationId]);

  // Save selected location to localStorage
  useEffect(() => {
    if (rawLocationId) {
      localStorage.setItem(SELECTED_LOCATION_KEY, rawLocationId.toString());
    }
  }, [rawLocationId]);

  // Load selected location from localStorage on mount
  useEffect(() => {
    const savedLocationId = localStorage.getItem(SELECTED_LOCATION_KEY);
    if (savedLocationId) {
      setRawLocationId((current) => current ?? parseInt(savedLocationId));
    }
  }, []);

  // FR1-1: only an id a successfully loaded list holds is published. `locations`
  // only ever holds a successful answer (a failed refresh keeps the last one),
  // so a restored id waits — as `null` — for the read that confirms it.
  const selectedLocation = locations.find(loc => loc.id === rawLocationId) || null;
  const selectedLocationId = selectedLocation?.id ?? null;

  // P2 (Lane 5): memoize the context value so an unrelated parent re-render does
  // not hand every consumer a fresh object literal (which forced a needless
  // re-render on every render of the provider's parent). setSelectedLocationId is
  // the stable useState setter, so it is intentionally out of the dep list.
  const value = React.useMemo(
    () => ({
      locations,
      selectedLocation,
      selectedLocationId,
      setSelectedLocationId: setRawLocationId,
      isLoading,
      loadFailed,
      retryLocations,
    }),
    [locations, selectedLocation, selectedLocationId, isLoading, loadFailed, retryLocations],
  );

  return (
    <LocationContext.Provider value={value}>
      {children}
    </LocationContext.Provider>
  );
}

export function useLocation() {
  const context = useContext(LocationContext);
  if (context === undefined) {
    throw new Error('useLocation must be used within a LocationProvider');
  }
  return context;
}
