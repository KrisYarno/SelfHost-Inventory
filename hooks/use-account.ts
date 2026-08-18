"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

export interface UserPreferences {
  emailAlerts?: boolean;
  minLocationEmailAlerts?: boolean;
  minCombinedEmailAlerts?: boolean;
  hasPassword?: boolean;
  username?: string;
}

// --- reads -----------------------------------------------------------------

// Locations for the default-location selector. RE-EXPORTED from the one home
// (plan P-9): this file used to carry its own copy under the SAME query key,
// with a different parser — see hooks/use-locations.ts for why that was a bug.
export { useLocations, type Location } from "@/hooks/use-locations";

// Account preferences (notification switches, hasPassword, username). Mutations below
// invalidate ["user-preferences"] so a later mount reflects the saved values.
export function useUserPreferences() {
  return useQuery<UserPreferences>({
    queryKey: ["user-preferences"],
    queryFn: async ({ signal }) => {
      const res = await fetch("/api/user/preferences", { signal });
      if (!res.ok) throw new Error("Failed to fetch preferences");
      return res.json();
    },
  });
}

// --- mutations -------------------------------------------------------------

// Default location lives on the session, not in ["user-preferences"], so nothing to
// invalidate here (matches the pre-migration handler, which only toasted).
export function useUpdateDefaultLocation() {
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (locationId: number) => {
      const res = await fetch("/api/account/default-location", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ locationId }),
      });
      if (!res.ok) throw new Error("Failed to update default location");
    },
  });
}

export function useUpdateUsername() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (username: string) => {
      const res = await fetch("/api/account/username", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify({ username }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update username");
      return data as { username: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-preferences"] });
    },
  });
}

// PATCH: change an existing password. hasPassword is unchanged, so no invalidation.
export function useUpdatePassword() {
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (input: { oldPassword: string; newPassword: string }) => {
      const res = await fetch("/api/account/password", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to update password");
      return data;
    },
  });
}

// POST: add a password for an OAuth-only user. hasPassword flips false -> true, so
// invalidate ["user-preferences"] to keep the cache honest.
export function useCreatePassword() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (input: { newPassword: string; confirmPassword: string }) => {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(input),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to create password");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-preferences"] });
    },
  });
}

export function useUpdatePreferences() {
  const queryClient = useQueryClient();
  const { token: csrfToken } = useCSRF();
  return useMutation({
    mutationFn: async (input: {
      emailAlerts: boolean;
      minLocationEmailAlerts: boolean;
      minCombinedEmailAlerts: boolean;
    }) => {
      const res = await fetch("/api/user/preferences", {
        method: "PATCH",
        headers: withCSRFHeaders({ "Content-Type": "application/json" }, csrfToken),
        body: JSON.stringify(input),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update notifications");
      }
      return res.json().catch(() => ({}));
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["user-preferences"] });
    },
  });
}
