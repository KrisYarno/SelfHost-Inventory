"use client";

import { useState, useEffect } from "react";
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
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

interface Location {
  id: number;
  name: string;
}

export default function AccountPage() {
  const { data: session } = useSession();
  const { token: csrfToken } = useCSRF();
  const [locations, setLocations] = useState<Location[]>([]);
  const [defaultLocation, setDefaultLocation] = useState<string>("");

  // Username state
  const [username, setUsername] = useState("");
  const [isEditingUsername, setIsEditingUsername] = useState(false);
  const [isLoadingUsername, setIsLoadingUsername] = useState(false);
  const [usernameError, setUsernameError] = useState("");

  // Password state
  const [hasPassword, setHasPassword] = useState<boolean | null>(null); // null = loading
  const [oldPassword, setOldPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [isLoadingLocation, setIsLoadingLocation] = useState(false);
  const [isLoadingPassword, setIsLoadingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordSuccess, setPasswordSuccess] = useState(false);

  // Notification state
  const [emailAlerts, setEmailAlerts] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [minLocationEmailAlerts, setMinLocationEmailAlerts] = useState(false);
  const [minLocationSmsAlerts, setMinLocationSmsAlerts] = useState(false);
  const [minCombinedEmailAlerts, setMinCombinedEmailAlerts] = useState(false);
  const [minCombinedSmsAlerts, setMinCombinedSmsAlerts] = useState(false);
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);

  // Fetch locations, user preferences, and account details
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch locations
        const locResponse = await fetch("/api/locations");
        if (locResponse.ok) {
          const locData = await locResponse.json();
          setLocations(locData);
        }

        // Fetch user preferences (includes hasPassword)
        const userResponse = await fetch("/api/user/preferences");
        if (userResponse.ok) {
          const userData = await userResponse.json();
          setEmailAlerts(userData.emailAlerts || false);
          setPhoneNumber(userData.phoneNumber || "");
          setMinLocationEmailAlerts(userData.minLocationEmailAlerts || false);
          setMinLocationSmsAlerts(userData.minLocationSmsAlerts || false);
          setMinCombinedEmailAlerts(userData.minCombinedEmailAlerts || false);
          setMinCombinedSmsAlerts(userData.minCombinedSmsAlerts || false);
          setHasPassword(userData.hasPassword ?? false);
          if (userData.username) {
            setUsername(userData.username);
          }
        }
      } catch (error) {
        console.error("Error fetching data:", error);
      }
    };

    fetchData();
  }, []);

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
    setIsLoadingLocation(true);
    try {
      const response = await fetch("/api/account/default-location", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ locationId: parseInt(defaultLocation) }),
      });

      if (!response.ok) {
        throw new Error("Failed to update default location");
      }

      toast.success("Default location updated successfully");
    } catch {
      toast.error("Failed to update default location");
    } finally {
      setIsLoadingLocation(false);
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

    setIsLoadingUsername(true);
    try {
      const response = await fetch("/api/account/username", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ username: username.toLowerCase() }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update username");
      }

      setUsername(data.username);
      setIsEditingUsername(false);
      toast.success("Username updated successfully");
    } catch (error) {
      setUsernameError(error instanceof Error ? error.message : "Failed to update username");
    } finally {
      setIsLoadingUsername(false);
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

    setIsLoadingPassword(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ oldPassword, newPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to update password");
      }

      setPasswordSuccess(true);
      toast.success("Password updated successfully");

      // Clear password fields
      setOldPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Failed to update password");
    } finally {
      setIsLoadingPassword(false);
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

    setIsLoadingPassword(true);
    try {
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ newPassword, confirmPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to create password");
      }

      setPasswordSuccess(true);
      setHasPassword(true);
      toast.success("Password created! You can now sign in with email and password.");

      // Clear password fields
      setNewPassword("");
      setConfirmPassword("");
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : "Failed to create password");
    } finally {
      setIsLoadingPassword(false);
    }
  };

  const handleNotificationSave = async () => {
    setIsSavingNotifications(true);
    try {
      const response = await fetch("/api/user/preferences", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          phoneNumber,
          emailAlerts,
          minLocationEmailAlerts,
          minLocationSmsAlerts,
          minCombinedEmailAlerts,
          minCombinedSmsAlerts,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || "Failed to update notifications");
      }

      toast.success("Notification preferences updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update notifications");
    } finally {
      setIsSavingNotifications(false);
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
                          disabled={isLoadingUsername}
                        >
                          {isLoadingUsername ? "Saving..." : "Save"}
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => {
                            setIsEditingUsername(false);
                            setUsernameError("");
                            setUsername(session?.user?.name || "");
                          }}
                          disabled={isLoadingUsername}
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
                  disabled={isLoadingLocation || !defaultLocation}
                  className="w-full sm:w-auto"
                >
                  {isLoadingLocation ? "Saving..." : "Save Default Location"}
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
              <div>
                <Label htmlFor="phone-number">Phone number for SMS alerts</Label>
                <Input
                  id="phone-number"
                  type="tel"
                  value={phoneNumber}
                  onChange={(event) => setPhoneNumber(event.target.value)}
                  placeholder="+1 (555) 123-4567"
                  className="mt-2"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  SMS notifications are sent only if a number is provided.
                </p>
              </div>

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
                    <p className="text-sm font-medium">Location minimum SMS alerts</p>
                    <p className="text-xs text-muted-foreground">
                      SMS alerts for refill needs at your default location.
                    </p>
                  </div>
                  <Switch
                    id="location-sms"
                    checked={minLocationSmsAlerts}
                    onCheckedChange={setMinLocationSmsAlerts}
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

                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="pr-4">
                    <p className="text-sm font-medium">Combined minimum SMS alerts</p>
                    <p className="text-xs text-muted-foreground">
                      SMS summary for products below combined minimums.
                    </p>
                  </div>
                  <Switch
                    id="combined-sms"
                    checked={minCombinedSmsAlerts}
                    onCheckedChange={setMinCombinedSmsAlerts}
                  />
                </div>
              </div>

              <Button
                onClick={handleNotificationSave}
                disabled={isSavingNotifications}
                className="w-full sm:w-auto"
              >
                {isSavingNotifications ? "Saving..." : "Save Notification Preferences"}
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
                  disabled={isLoadingPassword || hasPassword === null}
                  className="w-full sm:w-auto"
                >
                  {isLoadingPassword
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
