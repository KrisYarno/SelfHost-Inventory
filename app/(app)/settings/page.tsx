'use client';

import { useState, useEffect } from 'react';
import { useTheme } from 'next-themes';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Separator } from '@/components/ui/separator';
import { Monitor, Moon, Sun, Smartphone, Tablet, Info } from 'lucide-react';
import { toast } from 'sonner';

type DisplayMode = 'auto' | 'mobile' | 'tablet' | 'desktop';
type DateFormat = 'MM/DD/YYYY' | 'DD/MM/YYYY' | 'YYYY-MM-DD';
type TimeFormat = '12h' | '24h';

interface AppSettings {
  displayMode: DisplayMode;
  dateFormat: DateFormat;
  timeFormat: TimeFormat;
  itemsPerPage: number;
  autoRefresh: boolean;
  refreshInterval: number;
}

const DEFAULT_SETTINGS: AppSettings = {
  displayMode: 'auto',
  dateFormat: 'MM/DD/YYYY',
  timeFormat: '12h',
  itemsPerPage: 20,
  autoRefresh: true,
  refreshInterval: 30,
};

export default function SettingsPage() {
  const { theme, setTheme } = useTheme();
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [hasChanges, setHasChanges] = useState(false);

  // Load settings from localStorage
  useEffect(() => {
    const savedSettings = localStorage.getItem('appSettings');
    if (savedSettings) {
      try {
        const parsed = JSON.parse(savedSettings);
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      } catch (error) {
        console.error('Error loading settings:', error);
      }
    }
  }, []);

  const updateSetting = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const saveSettings = () => {
    localStorage.setItem('appSettings', JSON.stringify(settings));
    setHasChanges(false);
    toast.success('Settings saved successfully');
  };

  const resetSettings = () => {
    setSettings(DEFAULT_SETTINGS);
    localStorage.removeItem('appSettings');
    setHasChanges(false);
    toast.success('Settings reset to defaults');
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-border bg-background px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Application Settings</h1>
            <p className="text-sm text-muted-foreground">
              Configure your application preferences
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-6">
          {/* Theme Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>
                Customize how the application looks
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label>Theme</Label>
                <RadioGroup value={theme} onValueChange={setTheme}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="light" id="light" />
                    <Label htmlFor="light" className="flex items-center gap-2 font-normal cursor-pointer">
                      <Sun className="h-4 w-4" />
                      Light
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="dark" id="dark" />
                    <Label htmlFor="dark" className="flex items-center gap-2 font-normal cursor-pointer">
                      <Moon className="h-4 w-4" />
                      Dark
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="system" id="system" />
                    <Label htmlFor="system" className="flex items-center gap-2 font-normal cursor-pointer">
                      <Monitor className="h-4 w-4" />
                      System
                    </Label>
                  </div>
                </RadioGroup>
              </div>

              <Separator />

              <div className="space-y-3">
                <Label htmlFor="display-mode">Display Mode</Label>
                <Select 
                  value={settings.displayMode} 
                  onValueChange={(value: DisplayMode) => updateSetting('displayMode', value)}
                >
                  <SelectTrigger id="display-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">
                      <span className="flex items-center gap-2">
                        <Monitor className="h-4 w-4" />
                        Auto-detect
                      </span>
                    </SelectItem>
                    <SelectItem value="mobile">
                      <span className="flex items-center gap-2">
                        <Smartphone className="h-4 w-4" />
                        Mobile view
                      </span>
                    </SelectItem>
                    <SelectItem value="tablet">
                      <span className="flex items-center gap-2">
                        <Tablet className="h-4 w-4" />
                        Tablet view
                      </span>
                    </SelectItem>
                    <SelectItem value="desktop">
                      <span className="flex items-center gap-2">
                        <Monitor className="h-4 w-4" />
                        Desktop view
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Override responsive layout detection
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Regional Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Regional Settings</CardTitle>
              <CardDescription>
                Date and time format preferences
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label htmlFor="date-format">Date Format</Label>
                <Select 
                  value={settings.dateFormat} 
                  onValueChange={(value: DateFormat) => updateSetting('dateFormat', value)}
                >
                  <SelectTrigger id="date-format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="MM/DD/YYYY">MM/DD/YYYY (12/31/2024)</SelectItem>
                    <SelectItem value="DD/MM/YYYY">DD/MM/YYYY (31/12/2024)</SelectItem>
                    <SelectItem value="YYYY-MM-DD">YYYY-MM-DD (2024-12-31)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-3">
                <Label htmlFor="time-format">Time Format</Label>
                <Select 
                  value={settings.timeFormat} 
                  onValueChange={(value: TimeFormat) => updateSetting('timeFormat', value)}
                >
                  <SelectTrigger id="time-format">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="12h">12-hour (3:30 PM)</SelectItem>
                    <SelectItem value="24h">24-hour (15:30)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Display Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Display Settings</CardTitle>
              <CardDescription>
                Configure data display preferences
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label htmlFor="items-per-page">Items per page</Label>
                <Select 
                  value={settings.itemsPerPage.toString()} 
                  onValueChange={(value) => updateSetting('itemsPerPage', parseInt(value))}
                >
                  <SelectTrigger id="items-per-page">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="10">10 items</SelectItem>
                    <SelectItem value="20">20 items</SelectItem>
                    <SelectItem value="50">50 items</SelectItem>
                    <SelectItem value="100">100 items</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Number of items to show in tables and lists
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <div className="space-y-1">
                    <Label>Auto-refresh data</Label>
                    <p className="text-xs text-muted-foreground">
                      Automatically refresh inventory data
                    </p>
                  </div>
                  <Select 
                    value={settings.autoRefresh ? settings.refreshInterval.toString() : 'off'} 
                    onValueChange={(value) => {
                      if (value === 'off') {
                        updateSetting('autoRefresh', false);
                      } else {
                        updateSetting('autoRefresh', true);
                        updateSetting('refreshInterval', parseInt(value));
                      }
                    }}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="off">Off</SelectItem>
                      <SelectItem value="30">30 seconds</SelectItem>
                      <SelectItem value="60">1 minute</SelectItem>
                      <SelectItem value="300">5 minutes</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* About Section */}
          <Card>
            <CardHeader>
              <CardTitle>About</CardTitle>
              <CardDescription>
                Application information and resources
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  <div className="space-y-2">
                    <p>Inventory Management System v1.0.0</p>
                    <p className="text-xs">
                      Built with Next.js, Prisma, and Tailwind CSS
                    </p>
                  </div>
                </AlertDescription>
              </Alert>
              
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>For help and support, contact your system administrator.</p>
                <p>© 2024 Inventory Management System</p>
              </div>
            </CardContent>
          </Card>

          {/* Save Actions */}
          {hasChanges && (
            <div className="sticky bottom-0 bg-background/95 backdrop-blur-sm border-t p-4 -mx-6">
              <div className="max-w-2xl mx-auto flex gap-3 justify-end">
                <Button variant="outline" onClick={resetSettings}>
                  Reset to Defaults
                </Button>
                <Button onClick={saveSettings}>
                  Save Changes
                </Button>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}