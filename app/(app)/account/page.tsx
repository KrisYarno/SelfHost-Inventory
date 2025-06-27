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
import { AlertCircle, CheckCircle2, Mail } from 'lucide-react';
import { toast } from 'sonner';

interface Location {
  id: number;
  name: string;
}

export default function AccountPage() {
  const { data: session } = useSession();
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
  const [isLoadingEmailAlerts, setIsLoadingEmailAlerts] = useState(false);

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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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

  const handleEmailAlertsToggle = async () => {
    setIsLoadingEmailAlerts(true);
    try {
      const response = await fetch('/api/user/preferences', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailAlerts: !emailAlerts }),
      });

      if (!response.ok) {
        throw new Error('Failed to update email preferences');
      }

      setEmailAlerts(!emailAlerts);
      toast.success(`Email alerts ${!emailAlerts ? 'enabled' : 'disabled'}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update preferences');
    } finally {
      setIsLoadingEmailAlerts(false);
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

          {/* Email Notifications */}
          <Card>
            <CardHeader>
              <CardTitle>Email Notifications</CardTitle>
              <CardDescription>
                Manage your email notification preferences
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-0.5 pr-4">
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <Label htmlFor="email-alerts" className="text-base font-medium cursor-pointer">
                        Low Stock Alerts
                      </Label>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Receive daily email notifications when products fall below their stock thresholds
                    </p>
                  </div>
                  <Switch
                    id="email-alerts"
                    checked={emailAlerts}
                    onCheckedChange={handleEmailAlertsToggle}
                    disabled={isLoadingEmailAlerts}
                  />
                </div>
                {emailAlerts && (
                  <Alert>
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>
                      You&apos;ll receive a daily digest email at 7:00 AM MT if any products are below their thresholds
                    </AlertDescription>
                  </Alert>
                )}
              </div>
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