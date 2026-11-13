"use client";

import { useState } from "react";
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
import { useCSRF } from "@/hooks/use-csrf";
import { useUpdateUser, type UpdateUserInput } from "@/hooks/use-admin";
import { useSubmitLatch, type SubmitLatch } from "@/hooks/use-submit-latch";
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
  defaultLocationId?: number | null;
  emailAlerts?: boolean | null;
  minLocationEmailAlerts?: boolean;
  minCombinedEmailAlerts?: boolean;
  companies?: CompanyAssociation[];
}

interface EditUserDialogProps {
  /**
   * The user to edit, AS A READ ISSUED AFTER THE EDIT TAP RETURNED THEM (FR-R1
   * (2), CR-OC-3) — never a cached list row: the membership set is sent whole,
   * and the route deletes every membership absent from it, so a stale row
   * silently removed a grant made since. `null` while that read is in flight,
   * or when it failed (`readFailed`).
   */
  user: UserWithDetails | null;
  /** The read failed, or the user is gone: the sentence, and no form. */
  readFailed?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
  locations: Location[];
  companies: Company[];
}

interface FormValues {
  username: string;
  /** `null` = the user has no default location: the Select shows `Not set`. */
  defaultLocationId: number | null;
  isAdmin: boolean;
  emailAlerts: boolean;
  minLocationEmailAlerts: boolean;
  minCombinedEmailAlerts: boolean;
  companies: CompanyAssociation[];
}

/**
 * The PATCH body: only the fields that changed. The route treats every field as
 * optional (`app/api/admin/users/[userId]/route.ts`), and so does `UpdateUserInput`.
 */
type UserPatch = UpdateUserInput["data"];

/**
 * The user as the form first shows them, normalised once at mount: a stored
 * `emailAlerts: null` reads as `false` (the checkbox has no third state); a
 * missing default location stays `null` (never `1`).
 */
function initialFormValues(user: UserWithDetails): FormValues {
  return {
    username: user.username || "",
    defaultLocationId: user.defaultLocationId ?? null,
    isAdmin: user.isAdmin || false,
    emailAlerts: user.emailAlerts ?? false,
    minLocationEmailAlerts: user.minLocationEmailAlerts || false,
    minCombinedEmailAlerts: user.minCombinedEmailAlerts || false,
    companies: user.companies || [],
  };
}

/** Memberships are a SET of companies: order and the display names don't count. */
function sameCompanySet(a: CompanyAssociation[], b: CompanyAssociation[]): boolean {
  const ids = new Set(a.map((c) => c.companyId));
  return ids.size === new Set(b.map((c) => c.companyId)).size && b.every((c) => ids.has(c.companyId));
}

/**
 * The fields whose current value differs from the snapshot taken at mount, and
 * nothing else. When the membership set differs, the FULL new list is sent (the
 * route replaces the set). A default location is sent only once one is picked
 * and it differs; `Not set` is display-only and is never sent (the route takes
 * no null).
 */
function changedFields(initial: FormValues, current: FormValues): UserPatch {
  const body: UserPatch = {};
  if (current.username !== initial.username) body.username = current.username;
  if (current.defaultLocationId !== null && current.defaultLocationId !== initial.defaultLocationId) {
    body.defaultLocationId = current.defaultLocationId;
  }
  if (current.isAdmin !== initial.isAdmin) body.isAdmin = current.isAdmin;
  if (current.emailAlerts !== initial.emailAlerts) body.emailAlerts = current.emailAlerts;
  if (current.minLocationEmailAlerts !== initial.minLocationEmailAlerts) {
    body.minLocationEmailAlerts = current.minLocationEmailAlerts;
  }
  if (current.minCombinedEmailAlerts !== initial.minCombinedEmailAlerts) {
    body.minCombinedEmailAlerts = current.minCombinedEmailAlerts;
  }
  if (!sameCompanySet(current.companies, initial.companies)) {
    body.companies = current.companies.map((c) => ({ companyId: c.companyId }));
  }
  return body;
}

export function EditUserDialog({
  user,
  readFailed = false,
  open,
  onOpenChange,
  onSuccess,
  locations,
  companies,
}: EditUserDialogProps) {
  // The shared submit latch (§ P2-B3-1R, M-a.1; FR-R1 (2)): one PATCH per Save
  // — a double Enter or a double tap used to send two — and no dismissal
  // (Escape, a click outside, the X, Cancel) while it is in flight.
  const latch = useSubmitLatch();
  const handleOpenChange = latch.guardOpenChange(onOpenChange);

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit User</DialogTitle>
          {/* Until the fresh read answers, the description says where it is:
              `Loading…`, then the form — or `Couldn't load this user.` and no
              form when the read failed or the user is gone. */}
          <DialogDescription aria-live="polite">
            {user !== null
              ? `Update user details for ${user.email}`
              : readFailed
                ? "Couldn't load this user."
                : "Loading…"}
          </DialogDescription>
        </DialogHeader>

        {/* The form mounts only with the fresh read's user, so its snapshot is
            taken from THAT read — never from the list row the Edit tap came
            from. */}
        {user !== null && (
          <EditUserForm
            user={user}
            latch={latch}
            onOpenChange={onOpenChange}
            onCancel={() => handleOpenChange(false)}
            onSuccess={onSuccess}
            locations={locations}
            companies={companies}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface EditUserFormProps {
  user: UserWithDetails;
  latch: SubmitLatch;
  /** The host's RAW callback, for the success close (never the guard). */
  onOpenChange: (open: boolean) => void;
  /** Cancel, through the guard. */
  onCancel: () => void;
  onSuccess: () => void;
  locations: Location[];
  companies: Company[];
}

function EditUserForm({
  user,
  latch,
  onOpenChange,
  onCancel,
  onSuccess,
  locations,
  companies,
}: EditUserFormProps) {
  const { isLoading: csrfLoading } = useCSRF();
  const updateUser = useUpdateUser();
  const { busy, run } = latch;

  // Form state — set from props ONCE, at mount (§ P2-B3-1R, MS-3-1 / M-a.3).
  // The users page mounts the dialog per open and this form only once the
  // fresh read has answered, so every open starts from the stored user as it
  // is NOW; there is no prop-keyed effect to re-seed (or fail to re-seed) a
  // cancelled draft. `initial` is the snapshot the body is diffed against.
  const [initial] = useState(() => initialFormValues(user));
  const [username, setUsername] = useState(initial.username);
  const [defaultLocationId, setDefaultLocationId] = useState<number | null>(initial.defaultLocationId);
  const [isAdmin, setIsAdmin] = useState(initial.isAdmin);
  const [emailAlerts, setEmailAlerts] = useState(initial.emailAlerts);
  const [minLocationEmailAlerts, setMinLocationEmailAlerts] = useState(initial.minLocationEmailAlerts);
  const [minCombinedEmailAlerts, setMinCombinedEmailAlerts] = useState(initial.minCombinedEmailAlerts);
  const [userCompanies, setUserCompanies] = useState<CompanyAssociation[]>(initial.companies);

  // ONLY what changed is sent (MS-3-1/3-2/3-4): an untouched Admin box never
  // rides along with a username fix, an untouched stored `null` never records a
  // phantom update, and an unset default location is never sent as 1.
  const changes = changedFields(initial, {
    username,
    defaultLocationId,
    isAdmin,
    emailAlerts,
    minLocationEmailAlerts,
    minCombinedEmailAlerts,
    companies: userCompanies,
  });
  const hasChanges = Object.keys(changes).length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Nothing changed: Save is disabled, and no request is sent.
    if (!hasChanges) return;

    // Basic validation
    if (username.length < 2 || username.length > 50) {
      toast.error("Username must be between 2 and 50 characters");
      return;
    }

    try {
      const settled = await run(async () => {
        await updateUser.mutateAsync({
          id: user.id,
          data: changes,
        });
        return true as const;
      });
      // A second Save while the first holds the latch: nothing was sent.
      if (settled === undefined) return;

      toast.success("User updated successfully");
      // The host's RAW callback, never the guard, which drops a close while a
      // save holds the latch.
      onOpenChange(false);
      onSuccess();
    } catch (error) {
      console.error("Error updating user:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update user");
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

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* While a save is in flight the WHOLE form is frozen (M-a.1). */}
      <fieldset disabled={busy} className="min-w-0 space-y-6">
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
        </div>

        {/* Permissions Section */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-muted-foreground">Permissions</h3>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="defaultLocation">Default Location</Label>
              <Select
                value={defaultLocationId === null ? "" : defaultLocationId.toString()}
                onValueChange={(value) => {
                  if (value) setDefaultLocationId(parseInt(value));
                }}
              >
                <SelectTrigger id="defaultLocation">
                  <SelectValue placeholder="Not set" />
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
                id="minCombinedEmailAlerts"
                checked={minCombinedEmailAlerts}
                onCheckedChange={(checked) => setMinCombinedEmailAlerts(checked === true)}
              />
              <Label htmlFor="minCombinedEmailAlerts" className="cursor-pointer text-sm">
                Combined Email Alerts
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
      </fieldset>

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={busy}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={busy || csrfLoading || !hasChanges}>
          {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Changes
        </Button>
      </DialogFooter>
    </form>
  );
}
