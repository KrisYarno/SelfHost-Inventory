'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef, ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { toast } from 'sonner';
import { Location } from '@prisma/client';

/** Where the chosen location is remembered between visits. */
const SELECTED_LOCATION_KEY = 'selectedLocationId';

interface LocationContextType {
  locations: Location[];
  selectedLocation: Location | null;
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
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadFailed, setLoadFailed] = useState(false);
  // Bumped by `retryLocations` to run the fetch below again.
  const [reloadKey, setReloadKey] = useState(0);
  const defaultLocationId = session?.user?.defaultLocationId ?? null;
  // Facelift F1-5: set when a saved id was discarded with no default to fall
  // back to. The selection then stays empty — the chip asks — until the user
  // chooses; a later read never fills it in on their behalf.
  const awaitingChoiceRef = useRef(false);
  // Set once a stale id's discard has been announced, until an id is kept: the
  // warning shows ONCE per discard, whichever way it went.
  const staleWarnedRef = useRef(false);

  // Fetch locations on mount. The read only loads the list: which location is
  // selected is decided by the rules below, never here.
  useEffect(() => {
    async function fetchLocations() {
      try {
        const response = await fetch('/api/locations');
        if (response.ok) {
          const data = await response.json();
          setLocations(data);
          setLoadFailed(false);
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

    if (session) {
      fetchLocations();
    }
  }, [session, reloadKey]);

  // FR2-4: with no session the effect above fetches nothing, so a retry then
  // would set `isLoading` with no read to clear it. It does nothing instead.
  const retryLocations = useCallback(() => {
    if (!session) return;
    setIsLoading(true);
    setReloadKey((key) => key + 1);
  }, [session]);

  // Facelift F1-5 — which location every stock write targets. The rules run on
  // every SUCCESSFUL read, and never against a loading or failed one: a failed
  // refresh over a loaded list changes nothing, and a failed first read leaves
  // the saved id alone.
  //   - empty list: nothing is selected, and the saved id is removed;
  //   - a current id in the list: kept;
  //   - a current id NOT in the list (stale): discarded, for the user's default
  //     when it is in the list, otherwise for nothing — the chip asks. Either
  //     way a warning says ONCE where writes now land. A discarded id never
  //     falls to the first location;
  //   - nothing saved (first visit): the default when it is in the list,
  //     otherwise the first location.
  // The updaters only apply to the id the decision was made about, so a choice
  // the user made in between is never overwritten.
  useEffect(() => {
    if (isLoading || loadFailed) return;

    if (locations.length === 0) {
      awaitingChoiceRef.current = false;
      staleWarnedRef.current = false;
      setSelectedLocationId(null);
      localStorage.removeItem(SELECTED_LOCATION_KEY);
      return;
    }

    const inList = (id: number | null) => id !== null && locations.some((loc) => loc.id === id);
    const fallback = inList(defaultLocationId) ? defaultLocationId : null;

    if (selectedLocationId === null) {
      if (awaitingChoiceRef.current) return;
      const first = fallback ?? locations[0].id;
      setSelectedLocationId((current) => (current === null ? first : current));
      return;
    }

    if (inList(selectedLocationId)) {
      awaitingChoiceRef.current = false;
      staleWarnedRef.current = false;
      return;
    }

    if (!staleWarnedRef.current) {
      staleWarnedRef.current = true;
      const fallbackLocation = locations.find((loc) => loc.id === fallback);
      toast.warning(
        fallbackLocation
          ? `Your saved location is no longer available — now working at ${fallbackLocation.name}.`
          : 'Your saved location is no longer available. Choose a location.'
      );
    }
    if (fallback === null) awaitingChoiceRef.current = true;
    const discarded = selectedLocationId;
    setSelectedLocationId((current) => (Object.is(current, discarded) ? fallback : current));
  }, [locations, isLoading, loadFailed, selectedLocationId, defaultLocationId]);

  // Save selected location to localStorage
  useEffect(() => {
    if (selectedLocationId) {
      localStorage.setItem(SELECTED_LOCATION_KEY, selectedLocationId.toString());
    }
  }, [selectedLocationId]);

  // Load selected location from localStorage on mount
  useEffect(() => {
    const savedLocationId = localStorage.getItem(SELECTED_LOCATION_KEY);
    if (savedLocationId) {
      setSelectedLocationId((current) => current ?? parseInt(savedLocationId));
    }
  }, []);

  const selectedLocation = locations.find(loc => loc.id === selectedLocationId) || null;

  // P2 (Lane 5): memoize the context value so an unrelated parent re-render does
  // not hand every consumer a fresh object literal (which forced a needless
  // re-render on every render of the provider's parent). setSelectedLocationId is
  // the stable useState setter, so it is intentionally out of the dep list.
  const value = React.useMemo(
    () => ({
      locations,
      selectedLocation,
      selectedLocationId,
      setSelectedLocationId,
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
