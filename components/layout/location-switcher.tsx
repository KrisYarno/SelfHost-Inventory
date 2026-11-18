"use client";

import { Building2 } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useLocation } from "@/contexts/location-context";
import { Skeleton } from "@/components/ui/skeleton";
import { toneClasses } from "@/components/ui/tone-classes";

/**
 * The location chip (facelift F1-5; FL-A-3). The selected location is where
 * every stock write lands, so the chip always says which one it is — or that
 * there is none — and never silently disappears:
 *   - loading: a 44 px skeleton;
 *   - failed with nothing loaded: a warning Retry (a failed refresh over a
 *     loaded list keeps the chip as it was);
 *   - zero locations: a muted "No locations", with no menu;
 *   - loaded, nothing selected: "Choose location" in the warning tone;
 *   - loaded with a selection: "At: <name>".
 * A change says where the user now works, from the change handler only.
 */
export function LocationSwitcher() {
  const {
    locations,
    selectedLocation,
    setSelectedLocationId,
    isLoading,
    loadFailed,
    retryLocations,
  } = useLocation();

  const handleLocationChange = (value: string) => {
    const locationId = parseInt(value);
    setSelectedLocationId(locationId);
    const name = locations.find((location) => location.id === locationId)?.name;
    if (name) {
      toast(`Now working at ${name}.`, { id: "location-change", duration: 5000 });
    }
  };

  if (isLoading) {
    return <Skeleton className="h-11" />;
  }

  if (loadFailed && locations.length === 0) {
    return (
      <button
        type="button"
        onClick={retryLocations}
        className={cn(
          "flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-sm",
          toneClasses.warning
        )}
      >
        <Building2 className="h-4 w-4 shrink-0" />
        <span className="truncate">Locations failed — Retry</span>
      </button>
    );
  }

  if (locations.length === 0) {
    return (
      <div className="flex min-h-11 w-full items-center gap-2 px-3 text-sm text-muted-foreground">
        <Building2 className="h-4 w-4 shrink-0" />
        <span className="truncate">No locations</span>
      </div>
    );
  }

  return (
    <Select
      value={selectedLocation ? selectedLocation.id.toString() : ""}
      onValueChange={handleLocationChange}
    >
      {selectedLocation ? (
        <SelectTrigger
          className="min-h-11 w-full justify-start gap-2 bg-primary/15 border-primary/40"
          aria-label={`At: ${selectedLocation.name}. Change location`}
        >
          <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="shrink-0 text-muted-foreground">At:</span>
          <span className="truncate">{selectedLocation.name}</span>
        </SelectTrigger>
      ) : (
        <SelectTrigger
          className={cn(
            "min-h-11 w-full justify-start gap-2",
            toneClasses.warning,
            "data-[placeholder]:text-warning-foreground"
          )}
          aria-label="Choose location"
        >
          <Building2 className="h-4 w-4 shrink-0" />
          <span className="truncate">Choose location</span>
        </SelectTrigger>
      )}
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
