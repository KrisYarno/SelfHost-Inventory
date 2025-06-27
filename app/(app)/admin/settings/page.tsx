"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { 
  MapPin, 
  Plus, 
  Trash2,
  Settings as SettingsIcon,
  Building2,
  AlertTriangle
} from "lucide-react";
import Link from "next/link";

interface Location {
  id: number;
  name: string;
  _count?: {
    product_locations: number;
    inventory_logs: number;
  };
}

interface SystemSettings {
  locations: Location[];
}

export default function AdminSettingsPage() {
  const [newLocationName, setNewLocationName] = useState("");
  const [data, setData] = useState<SystemSettings | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAddingLocation, setIsAddingLocation] = useState(false);
  const [isDeletingLocation, setIsDeletingLocation] = useState(false);

  const fetchSettings = async () => {
    try {
      const response = await fetch("/api/admin/settings");
      if (!response.ok) throw new Error("Failed to fetch settings");
      const result = await response.json();
      setData(result);
    } catch (error) {
      console.error('Error fetching settings:', error);
      toast.error('Failed to load settings');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSettings();
  }, []);

  const handleAddLocation = async () => {
    if (!newLocationName.trim()) {
      toast.error("Location name cannot be empty");
      return;
    }
    
    try {
      setIsAddingLocation(true);
      const response = await fetch("/api/admin/locations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newLocationName.trim() }),
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to add location");
      }
      
      toast.success("Location added successfully");
      setNewLocationName("");
      await fetchSettings();
    } catch (error: any) {
      toast.error(error.message || "Failed to add location");
    } finally {
      setIsAddingLocation(false);
    }
  };

  const handleDeleteLocation = async (location: Location) => {
    const hasData = (location._count?.product_locations || 0) > 0 || 
                    (location._count?.inventory_logs || 0) > 0;
    
    if (hasData) {
      const confirmDelete = confirm(
        `${location.name} has associated inventory data. Are you sure you want to delete it?`
      );
      if (!confirmDelete) return;
    }

    try {
      setIsDeletingLocation(true);
      const response = await fetch(`/api/admin/locations/${location.id}`, {
        method: "DELETE",
      });
      
      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete location");
      }
      
      toast.success("Location deleted successfully");
      await fetchSettings();
    } catch (error: any) {
      toast.error(error.message || "Failed to delete location");
    } finally {
      setIsDeletingLocation(false);
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-6 space-y-6">
        <h1 className="text-3xl font-bold">System Settings</h1>
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-[300px]" />
          <Skeleton className="h-[300px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center gap-2">
        <SettingsIcon className="h-8 w-8" />
        <h1 className="text-3xl font-bold">System Settings</h1>
      </div>

      {/* Quick Actions */}
      <div className="grid gap-4 md:grid-cols-2">
        <Link href="/admin/settings/thresholds">
          <Card className="hover:shadow-md transition-shadow cursor-pointer">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AlertTriangle className="h-5 w-5 text-warning" />
                Low Stock Thresholds
              </CardTitle>
              <CardDescription>
                Configure when products should trigger low stock email alerts
              </CardDescription>
            </CardHeader>
          </Card>
        </Link>
      </div>

      {/* Location Management */}
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Location Management
            </CardTitle>
            <CardDescription>
              Manage inventory locations
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="New location name"
                value={newLocationName}
                onChange={(e) => setNewLocationName(e.target.value)}
                onKeyPress={(e) => e.key === 'Enter' && handleAddLocation()}
              />
              <Button
                onClick={handleAddLocation}
                disabled={isAddingLocation}
                size="icon"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2 max-h-[300px] overflow-y-auto">
              {data?.locations.map((location) => (
                <div
                  key={location.id}
                  className="flex items-center justify-between p-3 border rounded-lg"
                >
                  <div>
                    <p className="font-medium">{location.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {location._count?.product_locations || 0} products, 
                      {' '}{location._count?.inventory_logs || 0} transactions
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleDeleteLocation(location)}
                    disabled={isDeletingLocation || location.id === 1}
                    title={location.id === 1 ? "Cannot delete main location" : "Delete location"}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              ))}
              
              {data?.locations.length === 0 && (
                <p className="text-center text-muted-foreground py-4">
                  No locations found
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* System Information */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            System Information
          </CardTitle>
          <CardDescription>
            Overview of your inventory management system
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Purpose</p>
              <p className="text-sm">This system is designed for physical inventory count management, integrating seamlessly into your order packing workflow.</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Total Locations</p>
              <p className="text-sm">{data?.locations.length || 0} active locations</p>
            </div>
            <div>
              <p className="text-sm font-medium text-muted-foreground">Features</p>
              <ul className="text-sm list-disc list-inside space-y-1">
                <li>Real-time inventory tracking</li>
                <li>Multi-location support</li>
                <li>Complete audit trail</li>
                <li>Mobile-optimized interface</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}