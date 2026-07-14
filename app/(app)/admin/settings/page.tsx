"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  MapPin,
  Plus,
  Trash2,
  Settings as SettingsIcon,
  Building2,
  AlertTriangle,
  Mail,
  BarChart3,
  Sparkles,
} from "lucide-react";
import Link from "next/link";
import {
  useAdminSettings,
  useAddLocation,
  useDeleteSettingsLocation,
  useToggleSetting,
  type SettingsLocation,
} from "@/hooks/use-admin";
import { ReorderSettingsSection } from "@/components/admin/reorder-settings-section";

export default function AdminSettingsPage() {
  const [newLocationName, setNewLocationName] = useState("");
  const { data, isLoading, isError } = useAdminSettings();
  const addLocation = useAddLocation();
  const deleteLocation = useDeleteSettingsLocation();
  const toggleWeekly = useToggleSetting("weeklyReportsEnabled");
  const toggleAnalytics = useToggleSetting("analyticsRebuildEnabled");

  const isAddingLocation = addLocation.isPending;
  const isDeletingLocation = deleteLocation.isPending;
  const isTogglingWeekly = toggleWeekly.isPending;
  const isTogglingAnalytics = toggleAnalytics.isPending;

  // Preserve the original load-failure toast.
  useEffect(() => {
    if (isError) {
      toast.error("Failed to load settings");
    }
  }, [isError]);

  const handleAddLocation = async () => {
    if (!newLocationName.trim()) {
      toast.error("Location name cannot be empty");
      return;
    }

    try {
      await addLocation.mutateAsync(newLocationName.trim());
      toast.success("Location added successfully");
      setNewLocationName("");
    } catch (error: any) {
      toast.error(error.message || "Failed to add location");
    }
  };

  const handleDeleteLocation = async (location: SettingsLocation) => {
    // The server now decides deletability (D7): a location with any history is
    // blocked with a 409 whose message names each blocker. Just confirm intent;
    // the catch below surfaces the server's blocker list verbatim.
    if (!confirm(`Delete location ${location.name}?`)) return;

    try {
      await deleteLocation.mutateAsync(location.id);
      toast.success("Location deleted successfully");
    } catch (error: any) {
      toast.error(error.message || "Failed to delete location");
    }
  };

  const handleToggleWeeklyReports = async (enabled: boolean) => {
    try {
      await toggleWeekly.mutateAsync(enabled);
      toast.success(
        enabled
          ? "Weekly inventory reports enabled"
          : "Weekly inventory reports disabled"
      );
    } catch (error: any) {
      toast.error(error.message || "Failed to update setting");
    }
  };

  const handleToggleAnalyticsRebuild = async (enabled: boolean) => {
    try {
      await toggleAnalytics.mutateAsync(enabled);
      toast.success(
        enabled
          ? "Product analytics rebuilds enabled"
          : "Product analytics rebuilds disabled"
      );
    } catch (error: any) {
      toast.error(error.message || "Failed to update setting");
    }
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-4 sm:p-6 space-y-6 overflow-x-hidden">
        <h1 className="text-3xl font-bold">System Settings</h1>
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-[300px]" />
          <Skeleton className="h-[300px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="container mx-auto p-4 sm:p-6 space-y-6 overflow-x-hidden">
      <div className="flex items-center gap-2">
        <SettingsIcon className="h-8 w-8" />
        <h1 className="text-3xl font-bold">System Settings</h1>
      </div>

      {/* Quick actions — flat divide-y rows (D-B8: not shadowed cards; both
          rows reuse the AI-providers entry-row classes verbatim). */}
      <div className="divide-y divide-border overflow-hidden rounded-lg border bg-surface">
        <Link
          href="/admin/settings/thresholds"
          className="flex items-center gap-3 p-4 hover:bg-surface-hover"
        >
          <AlertTriangle className="h-5 w-5 shrink-0 text-warning" />
          <div className="min-w-0">
            <p className="font-medium">Low-stock alert thresholds</p>
            <p className="text-sm text-muted-foreground">
              Set the system default threshold and per-product overrides that
              trigger low-stock email alerts.
            </p>
          </div>
        </Link>
        <Link
          href="/admin/settings/ai"
          className="flex items-center gap-3 p-4 hover:bg-surface-hover"
        >
          <Sparkles className="h-5 w-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <p className="font-medium">AI providers &amp; assistant</p>
            <p className="text-sm text-muted-foreground">
              Configure AI providers, routing defaults, and read-only API tokens.
            </p>
          </div>
        </Link>
      </div>

      {/* Weekly Reports Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="h-5 w-5" />
            Weekly Inventory Reports
          </CardTitle>
          <CardDescription>
            Send a weekly email summary to all users who have email alerts enabled.
            Includes stock levels, low-stock warnings, top movers, and per-location breakdown.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label htmlFor="weekly-reports-toggle" className="cursor-pointer">
              {data?.weeklyReportsEnabled
                ? "Weekly reports are enabled"
                : "Weekly reports are disabled"}
            </Label>
            <Switch
              id="weekly-reports-toggle"
              checked={data?.weeklyReportsEnabled ?? false}
              onCheckedChange={handleToggleWeeklyReports}
              disabled={isTogglingWeekly}
            />
          </div>
        </CardContent>
      </Card>

      {/* Product Analytics Rebuild Toggle */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BarChart3 className="h-5 w-5" />
            Product Analytics Rebuilds
          </CardTitle>
          <CardDescription>
            Master switch for the scheduled analytics rebuilds (nightly stock
            snapshots + sales facts, plus the weekly full reconcile). When off,
            the scheduled trigger is a no-op and the materialized analytics layer
            stops refreshing.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between">
            <Label htmlFor="analytics-rebuild-toggle" className="cursor-pointer">
              {data?.analyticsRebuildEnabled
                ? "Analytics rebuilds are enabled"
                : "Analytics rebuilds are disabled"}
            </Label>
            <Switch
              id="analytics-rebuild-toggle"
              checked={data?.analyticsRebuildEnabled ?? false}
              onCheckedChange={handleToggleAnalyticsRebuild}
              disabled={isTogglingAnalytics}
            />
          </div>
        </CardContent>
      </Card>

      {/* Global reorder defaults */}
      <ReorderSettingsSection />

      {/* Location Management */}
      <div className="grid gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5" />
              Location Management
            </CardTitle>
            <CardDescription>Manage inventory locations</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex gap-2">
              <Input
                placeholder="New location name"
                value={newLocationName}
                onChange={(e) => setNewLocationName(e.target.value)}
                onKeyPress={(e) => e.key === "Enter" && handleAddLocation()}
              />
              <Button onClick={handleAddLocation} disabled={isAddingLocation} size="icon">
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
                      {location._count?.product_locations || 0} products,{" "}
                      {location._count?.inventory_logs || 0} transactions
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
                <p className="text-center text-muted-foreground py-4">No locations found</p>
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
          <CardDescription>Overview of your inventory management system</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-muted-foreground">Purpose</p>
              <p className="text-sm">
                This system is designed for physical inventory count management, integrating
                seamlessly into your order packing workflow.
              </p>
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
