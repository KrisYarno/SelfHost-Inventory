"use client";

import { useState, useEffect, useRef } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Switch } from "@/components/ui/switch";
import { AlertCircle, CheckCircle2, Pencil } from "lucide-react";
import { toast } from "sonner";
import {
  useLocations,
  useUserPreferences,
  useUpdateDefaultLocation,
  useUpdateUsername,
  useUpdatePassword,
  useCreatePassword,
  useUpdatePreferences,
} from "@/hooks/use-account";

export default function AccountPage() {
  const { data: session } = useSession();
  const locationsQuery = useLocations();
  const locations = locationsQuery.data ?? [];
  const preferencesQuery = useUserPreferences();
  const updateDefaultLocation = useUpdateDefaultLocation();
  const updateUsername = useUpdateUsername();
  const updatePassword = useUpdatePassword();
  const createPassword = useCreatePassword();
  const updatePreferences = useUpdatePreferences();
  const isPasswordPending = updatePassword.isPending || createPassword.isPending;
  const [defaultLocation, setDefaultLocation] = useState<string>("");

  // Username state
  const [username, setUsername] = useState("");
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState("");

  // Password state
  const [hasPassword, setHasPassword] = useState<boolean | null>(null); // null = loading
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Notification state
  const [emailAlerts, setEmailAlerts] = useState(false);
  const [minLocationEmailAlerts, setMinLocationEmailAlerts] = useState(false);
  const [minCombinedEmailAlerts, setMinCombinedEmailAlerts] = useState(false);

  // Seed the editable form state from the preferences query ONCE. A guard (not a plain
  // data-dep effect) so an invalidation-driven refetch after a save never clobbers other
  // unsaved edits on the page — mirrors the original single on-mount fetch.
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    const p = preferencesQuery.data;
    if (!p) return;
    seededRef.current = true;
    setEmailAlerts(p.emailAlerts || false);
    setMinLocationEmailAlerts(p.minLocationEmailAlerts || false);
    setMinCombinedEmailAlerts(p.minCombinedEmailAlerts || false);
    setHasPassword(p.hasPassword ?? false);
    if (p.username) {
      setUsername(p.username);
    }
  }, [preferencesQuery.data]);

  // Initialize username from session
  useEffect(() => {
    if (session?.user?.name && !username) {
      setUsername(session.user.name);
    }
  }, [session, username]);

  // Set default location from session
  useEffect(() => {
    if (session?.user?.defaultLocationId) {
      setDefaultLocation(session.user.defaultLocationId.toString());
    }
  }, [session]);

  const handleLocationSave = async () => {
    try {
      await updateDefaultLocation.mutateAsync(parseInt(defaultLocation));
      toast.success("Default location updated successfully");
    } catch {
      toast.error("Failed to update default location");
    }
  };

  const handleUsernameSave = async () => {
    setUsernameError("");

    if (!username.trim()) {
      setUsernameError("Username is required");
      return;
    }

    if (username.length < 3 || username.length > 30) {
      setUsernameError("Username must be 3-30 characters");
      return;
    }

    if (!/^[a-z0-9._]+$/.test(username.toLowerCase())) {
      setUsernameError("Username can only contain letters, numbers, dots, and underscores");
      return;
    }

    try {
      const data = await updateUsername.mutateAsync(username.toLowerCase());
      setUsername(data.username);
      setIsEditingUsername(false);
      toast.success("Username updated successfully");
    } catch (error) {
      setUsernameError(error instanceof Error ? error.message : "Failed to update username");
    }
  };

  const handlePasswordUpdate = async () => {
    // Reset states
    setPasswordError("");
    setPasswordSuccess(false);

    // Validate passwords
    if (!oldPassword || !newPassword || !confirmPassword) {
      setPasswordError("All password fields are required");
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError("New password must be at least 8 characters long");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords do not match");
      return;
    }

    try {
      await updatePassword.mutateAsync({ oldPassword, newPassword });
      setPasswordSuccess(true);
      toast.success("Password updated successfully");

      // Clear password fields
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Failed to update password");
    }
  };

  // Create a new password (for OAuth-only users)
  const handlePasswordCreate = async () => {
    setPasswordError("");
    setPasswordSuccess(false);

    if (!newPassword || !confirmPassword) {
      setPasswordError("Both password fields are required");
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError("Password must be at least 8 characters long");
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError("Passwords do not match");
      return;
    }

    try {
      await createPassword.mutateAsync({ newPassword, confirmPassword });
      setPasswordSuccess(true);
      setHasPassword(true);
      toast.success("Password created! You can now sign in with email and password.");

      // Clear password fields
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Failed to create password");
    }
  };

  const handleNotificationSave = async () => {
    try {
      await updatePreferences.mutateAsync({
        emailAlerts,
        minLocationEmailAlerts,
        minCombinedEmailAlerts,
      });
      toast.success("Notification preferences updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update notifications");
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-border bg-background px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Account Settings</h1>
            <p className="text-sm text-muted-foreground">
              Manage your account preferences and security
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Profile Information */}
          <Card>
            <CardHeader>
              <CardTitle>Profile Information</CardTitle>
              <CardDescription>Your account details and status</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <Label className="text-muted-foreground">Email</Label>
                  <p className="text-sm">{session?.user?.email}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Username</Label>
                  {isEditingUsername ? (
                    <div className="mt-1 space-y-2">
                      <Input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        placeholder="Enter username"
                        className="max-w-xs"
                      />
                      {usernameError && (
                        <p className="text-sm text-destructive">{usernameError}</p>
                      )}
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          onClick={handleUsernameSave}
                          disabled={updateUsername.isPending}
                        >
                          {updateUsername.isPending ? "Saving..." : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIsEditingUsername(false);
                            setUsernameError("");
                            setUsername(session?.user?.name || "");
                          }}
                          disabled={updateUsername.isPending}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <p className="text-sm">{username || session?.user?.name || "Not set"}</p>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 w-6 p-0"
                        onClick={() => setIsEditingUsername(true)}
                      >
                        <Pencil className="h-3 w-3" />
                        <span className="sr-only">Edit username</span>
                      </Button>
                    </div>
                  )}
                </div>
                <div>
                  <Label className="text-muted-foreground">Role</Label>
                  <p className="text-sm">{session?.user?.isAdmin ? "Administrator" : "User"}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Account Status</Label>
                  <p className="text-sm">
                    {session?.user?.isApproved ? "Approved" : "Pending Approval"}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Default Location */}
          <Card>
            <CardHeader>
              <CardTitle>Set Default Login Location</CardTitle>
              <CardDescription>
                This location will be automatically selected each time you log in.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div>
                  <Label htmlFor="location">Default Location:</Label>
                  <Select value={defaultLocation} onValueChange={setDefaultLocation}>
                    <SelectTrigger id="location" className="mt-2">
                      <SelectValue placeholder="Select a location" />
                    </SelectTrigger>
                    <SelectContent>
                      {locations.map((location) => (
                        <SelectItem key={location.id} value={location.id.toString()}>
                          {location.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  onClick={handleLocationSave}
                  disabled={updateDefaultLocation.isPending || !defaultLocation}
                  className="w-full sm:w-auto"
                >
                  {updateDefaultLocation.isPending ? "Saving..." : "Save Default Location"}
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Notification Preferences */}
          <Card>
            <CardHeader>
              <CardTitle>Notification Preferences</CardTitle>
              <CardDescription>
                Configure alerts for low stock, location minimums, and combined minimums.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="pr-4">
                    <p className="text-sm font-medium">Low stock email alerts</p>
                    <p className="text-xs text-muted-foreground">
                      Receive the existing daily digest when products fall below their global
                      thresholds.
                    </p>
                  </div>
                  <Switch
                    id="low-stock-email"
                    checked={emailAlerts}
                    onCheckedChange={setEmailAlerts}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="pr-4">
                    <p className="text-sm font-medium">Location minimum email alerts</p>
                    <p className="text-xs text-muted-foreground">
                      Notify me when my default location dips below its minimum.
                    </p>
                  </div>
                  <Switch
                    id="location-email"
                    checked={minLocationEmailAlerts}
                    onCheckedChange={setMinLocationEmailAlerts}
                  />
                </div>

                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="pr-4">
                    <p className="text-sm font-medium">Combined minimum email alerts</p>
                    <p className="text-xs text-muted-foreground">
                      Email me when total inventory for a product falls below its combined minimum.
                    </p>
                  </div>
                  <Switch
                    id="combined-email"
                    checked={minCombinedEmailAlerts}
                    onCheckedChange={setMinCombinedEmailAlerts}
                  />
                </div>
              </div>

              <Button
                onClick={handleNotificationSave}
                disabled={updatePreferences.isPending}
                className="w-full sm:w-auto"
              >
                {updatePreferences.isPending ? "Saving..." : "Save Notification Preferences"}
              </Button>
            </CardContent>
          </Card>

          {/* Password Management */}
          <Card>
            <CardHeader>
              <CardTitle>
                {hasPassword === null
                  ? "Password"
                  : hasPassword
                    ? "Change Password"
                    : "Add Password"}
              </CardTitle>
              <CardDescription>
                {hasPassword === null
                  ? "Loading password status..."
                  : hasPassword
                    ? "Update your password to keep your account secure"
                    : "Add a password to sign in with email and password in addition to Google"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {passwordError && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{passwordError}</AlertDescription>
                  </Alert>
                )}

                {passwordSuccess && (
                  <Alert className="border-success bg-success/10">
                    <CheckCircle2 className="h-4 w-4 text-success" />
                    <AlertDescription className="text-success">
                      {hasPassword ? "Password updated successfully" : "Password created successfully"}
                    </AlertDescription>
                  </Alert>
                )}

                {/* Show old password field only if user already has a password */}
                {hasPassword && (
                  <div>
                    <Label htmlFor="old-password">Current Password</Label>
                    <Input
                      id="old-password"
                      type="password"
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                      className="mt-2"
                    />
                  </div>
                )}

                <div>
                  <Label htmlFor="new-password">
                    {hasPassword ? "New Password" : "Password"}
                  </Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="mt-2"
                    placeholder="Minimum 8 characters"
                  />
                </div>

                <div>
                  <Label htmlFor="confirm-password">Confirm Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="mt-2"
                  />
                </div>

                <Button
                  onClick={hasPassword ? handlePasswordUpdate : handlePasswordCreate}
                  disabled={isPasswordPending || hasPassword === null}
                  className="w-full sm:w-auto"
                >
                  {isPasswordPending
                    ? hasPassword
                      ? "Updating..."
                      : "Creating..."
                    : hasPassword
                      ? "Update Password"
                      : "Create Password"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
