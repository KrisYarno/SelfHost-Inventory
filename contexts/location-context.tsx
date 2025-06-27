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

  return (
    <LocationContext.Provider 
      value={{
        locations,
        selectedLocation,
        selectedLocationId,
        setSelectedLocationId,
        isLoading,
      }}
    >
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