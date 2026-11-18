"use client";

import { useTheme } from "next-themes";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Monitor, Moon, Sun, Info } from "lucide-react";

/**
 * Application settings (F0-9): only settings that do something. The theme is
 * applied by next-themes. Display mode, date and time format, items per page and
 * auto-refresh were saved to localStorage and read by nothing, so they are gone.
 */
export default function SettingsPage() {
  const { theme, setTheme } = useTheme();

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-border bg-background px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Application Settings</h1>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex-1 p-6 overflow-y-auto">
        <div className="max-w-3xl space-y-6">
          {/* Theme Settings */}
          <Card>
            <CardHeader>
              <CardTitle>Appearance</CardTitle>
              <CardDescription>Customize how the application looks</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="space-y-3">
                <Label>Theme</Label>
                <RadioGroup value={theme} onValueChange={setTheme}>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="light" id="light" />
                    <Label
                      htmlFor="light"
                      className="flex items-center gap-2 font-normal cursor-pointer"
                    >
                      <Sun className="h-4 w-4" />
                      Light
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="dark" id="dark" />
                    <Label
                      htmlFor="dark"
                      className="flex items-center gap-2 font-normal cursor-pointer"
                    >
                      <Moon className="h-4 w-4" />
                      Dark
                    </Label>
                  </div>
                  <div className="flex items-center space-x-2">
                    <RadioGroupItem value="system" id="system" />
                    <Label
                      htmlFor="system"
                      className="flex items-center gap-2 font-normal cursor-pointer"
                    >
                      <Monitor className="h-4 w-4" />
                      System
                    </Label>
                  </div>
                </RadioGroup>
              </div>
            </CardContent>
          </Card>

          {/* About Section */}
          <Card>
            <CardHeader>
              <CardTitle>About</CardTitle>
              <CardDescription>Application information and resources</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription>
                  <div className="space-y-2">
                    <p>Inventory Management System</p>
                    <p className="text-xs">Built with Next.js, Prisma, and Tailwind CSS</p>
                  </div>
                </AlertDescription>
              </Alert>

              <div className="space-y-2 text-sm text-muted-foreground">
                <p>For help and support, contact your system administrator.</p>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
