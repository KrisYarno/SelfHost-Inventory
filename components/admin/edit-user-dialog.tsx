"use client";

import { useState, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";
import { Loader2, Plus, Trash2 } from "lucide-react";

interface Location {
  id: number;
  name: string;
}

interface Company {
  id: string;
  name: string;
  slug: string;
}

interface CompanyAssociation {
  companyId: string;
  companyName?: string;
}

interface UserWithDetails {
  id: number;
  email: string;
  username: string;
  isAdmin: boolean;
  isApproved: boolean;
  defaultLocationId?: number;
  emailAlerts?: boolean | null;
  phoneNumber?: string | null;
  minLocationEmailAlerts?: boolean;
  minLocationSmsAlerts?: boolean;
  minCombinedEmailAlerts?: boolean;
  minCombinedSmsAlerts?: boolean;
  companies?: CompanyAssociation[];
}

interface EditUserDialogProps {
  user: UserWithDetails | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  locations: Location[];
  companies: Company[];
}

export function EditUserDialog({
  user,
  open,
  onOpenChange,
  onSuccess,
  locations,
  companies,
}: EditUserDialogProps) {
  const { token: csrfToken, isLoading: csrfLoading } = useCSRF();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Form state
  const [username, setUsername] = useState("");
  const [phoneNumber, setPhoneNumber] = useState("");
  const [defaultLocationId, setDefaultLocationId] = useState<number>(1);
  const [isAdmin, setIsAdmin] = useState(false);
  const [emailAlerts, setEmailAlerts] = useState(false);
  const [minLocationEmailAlerts, setMinLocationEmailAlerts] = useState(false);
  const [minLocationSmsAlerts, setMinLocationSmsAlerts] = useState(false);
  const [minCombinedEmailAlerts, setMinCombinedEmailAlerts] = useState(false);
  const [minCombinedSmsAlerts, setMinCombinedSmsAlerts] = useState(false);
  const [userCompanies, setUserCompanies] = useState<CompanyAssociation[]>([]);

  // Reset form when user changes
  useEffect(() => {
    if (user) {
      setUsername(user.username || "");
      setPhoneNumber(user.phoneNumber || "");
      setDefaultLocationId(user.defaultLocationId || 1);
      setIsAdmin(user.isAdmin || false);
      setEmailAlerts(user.emailAlerts || false);
      setMinLocationEmailAlerts(user.minLocationEmailAlerts || false);
      setMinLocationSmsAlerts(user.minLocationSmsAlerts || false);
      setMinCombinedEmailAlerts(user.minCombinedEmailAlerts || false);
      setMinCombinedSmsAlerts(user.minCombinedSmsAlerts || false);
      setUserCompanies(user.companies || []);
    }
  }, [user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;

    // Basic validation
    if (username.length < 2 || username.length > 50) {
      toast.error("Username must be between 2 and 50 characters");
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await fetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({
          username,
          phoneNumber: phoneNumber || null,
          defaultLocationId,
          isAdmin,
          emailAlerts,
          minLocationEmailAlerts,
          minLocationSmsAlerts,
          minCombinedEmailAlerts,
          minCombinedSmsAlerts,
          companies: userCompanies.map((c) => ({
            companyId: c.companyId,
          })),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update user");
      }

      toast.success("User updated successfully");
      onOpenChange(false);
      onSuccess();
    } catch (error) {
      console.error("Error updating user:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update user");
    } finally {
      setIsSubmitting(false);
    }
  };

  const addCompanyAssociation = () => {
    // Find a company that's not already associated
    const availableCompany = companies.find(
      (c) => !userCompanies.some((uc) => uc.companyId === c.id)
    );
    if (availableCompany) {
      setUserCompanies([
        ...userCompanies,
        { companyId: availableCompany.id, companyName: availableCompany.name },
      ]);
    }
  };

  const removeCompanyAssociation = (companyId: string) => {
    setUserCompanies(userCompanies.filter((c) => c.companyId !== companyId));
  };

  const updateCompanyId = (oldCompanyId: string, newCompanyId: string) => {
    const company = companies.find((c) => c.id === newCompanyId);
    setUserCompanies(
      userCompanies.map((c) =>
        c.companyId === oldCompanyId
          ? { ...c, companyId: newCompanyId, companyName: company?.name }
          : c
      )
    );
  };

  const availableCompanies = companies.filter(
    (c) => !userCompanies.some((uc) => uc.companyId === c.id)
  );

  if (!user) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          <DialogDescription>
            Update user details for {user.email}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-6">
          {/* Basic Info Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Basic Information</h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Enter username"
                  minLength={2}
                  maxLength={50}
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  value={user.email}
                  disabled
                  className="bg-muted"
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="phone">Phone Number</Label>
              <Input
                id="phone"
                type="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder="+1 (555) 123-4567"
              />
            </div>
          </div>

          {/* Permissions Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Permissions</h3>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="defaultLocation">Default Location</Label>
                <Select
                  value={defaultLocationId.toString()}
                  onValueChange={(value) => setDefaultLocationId(parseInt(value))}
                >
                  <SelectTrigger id="defaultLocation">
                    <SelectValue placeholder="Select location" />
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

              <div className="flex items-center space-x-2 pt-6">
                <Checkbox
                  id="isAdmin"
                  checked={isAdmin}
                  onCheckedChange={(checked) => setIsAdmin(checked === true)}
                />
                <Label htmlFor="isAdmin" className="cursor-pointer">
                  Admin Role
                </Label>
              </div>
            </div>
          </div>

          {/* Notification Preferences Section */}
          <div className="space-y-4">
            <h3 className="text-sm font-medium text-muted-foreground">Notification Preferences</h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex items-center space-x-2">
                <Checkbox
                  id="emailAlerts"
                  checked={emailAlerts}
                  onCheckedChange={(checked) => setEmailAlerts(checked === true)}
                />
                <Label htmlFor="emailAlerts" className="cursor-pointer text-sm">
                  Email Alerts
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="minLocationEmailAlerts"
                  checked={minLocationEmailAlerts}
                  onCheckedChange={(checked) => setMinLocationEmailAlerts(checked === true)}
                />
                <Label htmlFor="minLocationEmailAlerts" className="cursor-pointer text-sm">
                  Per-Location Email Alerts
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="minLocationSmsAlerts"
                  checked={minLocationSmsAlerts}
                  onCheckedChange={(checked) => setMinLocationSmsAlerts(checked === true)}
                />
                <Label htmlFor="minLocationSmsAlerts" className="cursor-pointer text-sm">
                  Per-Location SMS Alerts
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="minCombinedEmailAlerts"
                  checked={minCombinedEmailAlerts}
                  onCheckedChange={(checked) => setMinCombinedEmailAlerts(checked === true)}
                />
                <Label htmlFor="minCombinedEmailAlerts" className="cursor-pointer text-sm">
                  Combined Email Alerts
                </Label>
              </div>

              <div className="flex items-center space-x-2">
                <Checkbox
                  id="minCombinedSmsAlerts"
                  checked={minCombinedSmsAlerts}
                  onCheckedChange={(checked) => setMinCombinedSmsAlerts(checked === true)}
                />
                <Label htmlFor="minCombinedSmsAlerts" className="cursor-pointer text-sm">
                  Combined SMS Alerts
                </Label>
              </div>
            </div>
          </div>

          {/* Company Associations Section */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">Company Associations</h3>
              {availableCompanies.length > 0 && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addCompanyAssociation}
                >
                  <Plus className="h-4 w-4 mr-1" />
                  Add Company
                </Button>
              )}
            </div>

            {userCompanies.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                No company associations. Add a company to allow this user to view orders.
              </p>
            ) : (
              <div className="space-y-2">
                {userCompanies.map((assoc) => (
                  <div
                    key={assoc.companyId}
                    className="flex items-center gap-2 p-2 rounded-lg border bg-muted/30"
                  >
                    <Select
                      value={assoc.companyId}
                      onValueChange={(value) => updateCompanyId(assoc.companyId, value)}
                    >
                      <SelectTrigger className="flex-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {/* Show current company plus available ones */}
                        {companies
                          .filter(
                            (c) =>
                              c.id === assoc.companyId ||
                              !userCompanies.some((uc) => uc.companyId === c.id)
                          )
                          .map((company) => (
                            <SelectItem key={company.id} value={company.id}>
                              {company.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>

                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeCompanyAssociation(assoc.companyId)}
                      className="text-destructive hover:text-destructive"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {companies.length === 0 && (
              <p className="text-sm text-muted-foreground italic">
                No companies exist yet. Create a company first to associate users.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isSubmitting || csrfLoading}>
              {isSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
