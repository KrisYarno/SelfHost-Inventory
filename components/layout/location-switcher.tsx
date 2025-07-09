"use client";

import { Building2 } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLocation } from "@/contexts/location-context";
import { Skeleton } from "@/components/ui/skeleton";

export function LocationSwitcher() {
  const { locations, selectedLocationId, setSelectedLocationId, isLoading } = useLocation();

  const handleLocationChange = (locationId: string) => {
    setSelectedLocationId(parseInt(locationId));
  };

  if (isLoading) {
    return <Skeleton className="h-10 w-full" />;
  }

  if (locations.length === 0) {
    return null;
  }

  return (
    <Select 
      value={selectedLocationId ? selectedLocationId.toString() : undefined} 
      onValueChange={handleLocationChange}
    >
      <SelectTrigger 
        className={cn(
          "w-full justify-start gap-2",
          "bg-background hover:bg-surface-hover",
          "border-border"
        )}
        aria-label="Select location"
      >
        <Building2 className="h-4 w-4 text-muted-foreground" />
        <SelectValue placeholder="Select location" />
      </SelectTrigger>
      <SelectContent>
        {locations.map((location) => (
          <SelectItem key={location.id} value={location.id.toString()}>
            <div className="flex flex-col">
              <span className="font-medium">{location.name}</span>
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}