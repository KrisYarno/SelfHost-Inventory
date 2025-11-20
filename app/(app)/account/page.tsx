'use client';

import { useState, useEffect } from 'react';
import { useSession } from 'next-auth/react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { useCSRF, withCSRFHeaders } from '@/hooks/use-csrf';

interface Location {
  id: number;
  name: string;
}

export default function AccountPage() {
  const { data: session } = useSession();
  const { token: csrfToken } = useCSRF();
  const [locations, setLocations] = useState<Location[]>([]);
  const [defaultLocation, setDefaultLocation] = useState<string>('');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoadingLocation, setIsLoadingLocation] = useState(false);
  const [isLoadingPassword, setIsLoadingPassword] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState(false);
  const [emailAlerts, setEmailAlerts] = useState(false);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [minLocationEmailAlerts, setMinLocationEmailAlerts] = useState(false);
  const [minLocationSmsAlerts, setMinLocationSmsAlerts] = useState(false);
  const [minCombinedEmailAlerts, setMinCombinedEmailAlerts] = useState(false);
  const [minCombinedSmsAlerts, setMinCombinedSmsAlerts] = useState(false);
  const [isSavingNotifications, setIsSavingNotifications] = useState(false);

  // Fetch locations and user preferences
  useEffect(() => {
    const fetchData = async () => {
      try {
        // Fetch locations
        const locResponse = await fetch('/api/locations');
        if (locResponse.ok) {
          const locData = await locResponse.json();
          setLocations(locData);
        }
        
        // Fetch user preferences
        const userResponse = await fetch('/api/user/preferences');
        if (userResponse.ok) {
          const userData = await userResponse.json();
          setEmailAlerts(userData.emailAlerts || false);
          setPhoneNumber(userData.phoneNumber || '');
          setMinLocationEmailAlerts(userData.minLocationEmailAlerts || false);
          setMinLocationSmsAlerts(userData.minLocationSmsAlerts || false);
          setMinCombinedEmailAlerts(userData.minCombinedEmailAlerts || false);
          setMinCombinedSmsAlerts(userData.minCombinedSmsAlerts || false);
        }
      } catch (error) {
        console.error('Error fetching data:', error);
      }
    };

    fetchData();
  }, []);

  // Set default location from session
  useEffect(() => {
    if (session?.user?.defaultLocationId) {
      setDefaultLocation(session.user.defaultLocationId.toString());
    }
  }, [session]);

  const handleLocationSave = async () => {
    setIsLoadingLocation(true);
    try {
      const response = await fetch('/api/account/default-location', {
        method: 'PATCH',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
        body: JSON.stringify({ locationId: parseInt(defaultLocation) }),
      });

      if (!response.ok) {
        throw new Error('Failed to update default location');
      }

      toast.success('Default location updated successfully');
    } catch {
      toast.error('Failed to update default location');
    } finally {
      setIsLoadingLocation(false);
    }
  };

  const handlePasswordUpdate = async () => {
    // Reset states
    setPasswordError('');
    setPasswordSuccess(false);

    // Validate passwords
    if (!oldPassword || !newPassword || !confirmPassword) {
      setPasswordError('All password fields are required');
      return;
    }

    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters long');
      return;
    }

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }

    setIsLoadingPassword(true);
    try {
      const response = await fetch('/api/account/password', {
        method: 'PATCH',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
        body: JSON.stringify({ oldPassword, newPassword }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to update password');
      }

      setPasswordSuccess(true);
      toast.success('Password updated successfully');
      
      // Clear password fields
      setOldPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (error) {
      setPasswordError(error instanceof Error ? error.message : 'Failed to update password');
    } finally {
      setIsLoadingPassword(false);
    }
  };

  const handleNotificationSave = async () => {
    setIsSavingNotifications(true);
    try {
      const response = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: withCSRFHeaders({ 'Content-Type': 'application/json' }, csrfToken),
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
        throw new Error(data.error || 'Failed to update notifications');
      }

      toast.success('Notification preferences updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update notifications');
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
                  <p className="text-sm">{session?.user?.name || 'Not set'}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Role</Label>
                  <p className="text-sm">{session?.user?.isAdmin ? 'Administrator' : 'User'}</p>
                </div>
                <div>
                  <Label className="text-muted-foreground">Account Status</Label>
                  <p className="text-sm">{session?.user?.isApproved ? 'Approved' : 'Pending Approval'}</p>
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
                  {isLoadingLocation ? 'Saving...' : 'Save Default Location'}
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
                      Receive the existing daily digest when products fall below their global thresholds.
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
                {isSavingNotifications ? 'Saving...' : 'Save Notification Preferences'}
              </Button>
            </CardContent>
          </Card>

          {/* Change Password */}
          <Card>
            <CardHeader>
              <CardTitle>Change Password</CardTitle>
              <CardDescription>
                Update your password to keep your account secure
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
                      Password updated successfully
                    </AlertDescription>
                  </Alert>
                )}

                <div>
                  <Label htmlFor="old-password">Old Password</Label>
                  <Input
                    id="old-password"
                    type="password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    className="mt-2"
                  />
                </div>
                
                <div>
                  <Label htmlFor="new-password">New Password</Label>
                  <Input
                    id="new-password"
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    className="mt-2"
                  />
                </div>
                
                <div>
                  <Label htmlFor="confirm-password">Confirm New Password</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="mt-2"
                  />
                </div>
                
                <Button
                  onClick={handlePasswordUpdate}
                  disabled={isLoadingPassword}
                  className="w-full sm:w-auto"
                >
                  {isLoadingPassword ? 'Updating...' : 'Update Password'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
}
