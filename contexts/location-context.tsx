'use client';

import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { useSession } from 'next-auth/react';
import { Location } from '@prisma/client';

interface LocationContextType {
  locations: Location[];
  selectedLocation: Location | null;
  selectedLocationId: number | null;
  setSelectedLocationId: (locationId: number) => void;
  isLoading: boolean;
}

const LocationContext = createContext<LocationContextType | undefined>(undefined);

export function LocationProvider({ children }: { children: ReactNode }) {
  const { data: session } = useSession();
  const [locations, setLocations] = useState<Location[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Fetch locations on mount
  useEffect(() => {
    async function fetchLocations() {
      try {
        const response = await fetch('/api/locations');
        if (response.ok) {
          const data = await response.json();
          setLocations(data);
          
          // Set initial location from user's default or first location
          if (data.length > 0 && !selectedLocationId) {
            const defaultLocationId = session?.user?.defaultLocationId || data[0].id;
            setSelectedLocationId(defaultLocationId);
          }
        }
      } catch (error) {
        console.error('Failed to fetch locations:', error);
      } finally {
        setIsLoading(false);
      }
    }

    if (session) {
      fetchLocations();
    }
  }, [session]);

  // Save selected location to localStorage
  useEffect(() => {
    if (selectedLocationId) {
      localStorage.setItem('selectedLocationId', selectedLocationId.toString());
    }
  }, [selectedLocationId]);

  // Load selected location from localStorage on mount
  useEffect(() => {
    const savedLocationId = localStorage.getItem('selectedLocationId');
    if (savedLocationId && !selectedLocationId) {
      setSelectedLocationId(parseInt(savedLocationId));
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
    }),
    [locations, selectedLocation, selectedLocationId, isLoading],
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