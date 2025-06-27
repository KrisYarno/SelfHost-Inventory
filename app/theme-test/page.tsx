"use client";

import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useTheme } from "next-themes";
import { useEffect, useState } from "react";

export default function ThemeTestPage() {
  const { theme, resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  const currentTheme = theme === "system" ? resolvedTheme : theme;

  return (
    <div className="min-h-screen bg-background p-8">
      <div className="max-w-4xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <h1 className="text-4xl font-bold">Theme Test Page</h1>
          <ThemeToggle />
        </div>

        <div className="grid gap-6">
          {/* Current Theme Info */}
          <Card>
            <CardHeader>
              <CardTitle>Current Theme</CardTitle>
              <CardDescription>Theme information and state</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <p className="text-sm">
                  <span className="font-medium">Selected Theme:</span> {theme}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Resolved Theme:</span> {resolvedTheme}
                </p>
                <p className="text-sm">
                  <span className="font-medium">Active Theme:</span> {currentTheme}
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Color Showcase */}
          <Card>
            <CardHeader>
              <CardTitle>Color System</CardTitle>
              <CardDescription>Theme-aware color palette</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <div className="h-20 bg-primary rounded-lg"></div>
                  <p className="text-sm text-center">Primary</p>
                </div>
                <div className="space-y-2">
                  <div className="h-20 bg-accent rounded-lg"></div>
                  <p className="text-sm text-center">Accent</p>
                </div>
                <div className="space-y-2">
                  <div className="h-20 bg-surface rounded-lg border"></div>
                  <p className="text-sm text-center">Surface</p>
                </div>
                <div className="space-y-2">
                  <div className="h-20 bg-muted rounded-lg"></div>
                  <p className="text-sm text-center">Muted</p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Components */}
          <Card>
            <CardHeader>
              <CardTitle>UI Components</CardTitle>
              <CardDescription>Test various components with theme</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Buttons */}
              <div className="space-y-2">
                <Label>Buttons</Label>
                <div className="flex gap-2 flex-wrap">
                  <Button>Default</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="destructive">Destructive</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="link">Link</Button>
                </div>
              </div>

              {/* Form Elements */}
              <div className="space-y-2">
                <Label htmlFor="test-input">Input Field</Label>
                <Input id="test-input" placeholder="Test input with theme support" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="test-select">Select</Label>
                <Select>
                  <SelectTrigger id="test-select">
                    <SelectValue placeholder="Select an option" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="light">Light Theme</SelectItem>
                    <SelectItem value="dark">Dark Theme</SelectItem>
                    <SelectItem value="system">System Theme</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Badges */}
              <div className="space-y-2">
                <Label>Badges</Label>
                <div className="flex gap-2 flex-wrap">
                  <Badge>Default</Badge>
                  <Badge variant="secondary">Secondary</Badge>
                  <Badge variant="destructive">Destructive</Badge>
                  <Badge variant="outline">Outline</Badge>
                </div>
              </div>

              {/* Alerts */}
              <div className="space-y-2">
                <Label>Alerts</Label>
                <Alert>
                  <AlertTitle>Default Alert</AlertTitle>
                  <AlertDescription>
                    This alert adapts to the current theme.
                  </AlertDescription>
                </Alert>
              </div>
            </CardContent>
          </Card>

          {/* Typography */}
          <Card>
            <CardHeader>
              <CardTitle>Typography</CardTitle>
              <CardDescription>Text styles with theme support</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <h1 className="text-4xl font-bold">Heading 1</h1>
              <h2 className="text-3xl font-semibold">Heading 2</h2>
              <h3 className="text-2xl font-semibold">Heading 3</h3>
              <h4 className="text-xl font-semibold">Heading 4</h4>
              <p className="text-lg">Large paragraph text</p>
              <p>Regular paragraph text with theme-aware colors</p>
              <p className="text-sm text-muted-foreground">Small muted text</p>
              <p className="font-mono">Monospace text: 123.456</p>
            </CardContent>
          </Card>

          {/* Inventory Specific */}
          <Card>
            <CardHeader>
              <CardTitle>Inventory Colors</CardTitle>
              <CardDescription>Domain-specific color system</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-3 gap-4">
                <div className="space-y-2">
                  <div className="h-16 bg-inventory-increase rounded-lg"></div>
                  <p className="text-sm text-center">Increase</p>
                </div>
                <div className="space-y-2">
                  <div className="h-16 bg-inventory-decrease rounded-lg"></div>
                  <p className="text-sm text-center">Decrease</p>
                </div>
                <div className="space-y-2">
                  <div className="h-16 bg-inventory-neutral rounded-lg"></div>
                  <p className="text-sm text-center">Neutral</p>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}