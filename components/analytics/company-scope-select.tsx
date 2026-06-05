"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useUserCompanies } from "@/hooks/use-external-orders";

interface Company {
  id: string;
  name: string;
  slug: string;
}

// "All my companies" is the omit-companyId default; its total = sum across the caller's
// memberships (server-side). A specific selection emits that company's string id.
//
// ER-D3: the option list is the caller's member companies, the SAME source the rollup uses.
// We pass `membershipsOnly` to useUserCompanies so /api/companies/user returns ONLY the caller's
// memberships and SKIPS the zero-membership admin-sees-all convenience branch. That keeps the
// picker and the "All my companies" total in agreement even for a zero-membership admin (whose
// memberships sum is empty), so they pick companies explicitly. We do NOT re-filter client-side
// — the endpoint owns scope truth.
const ALL = "__all__";

interface CompanyScopeSelectProps {
  /** undefined = "All my companies" (omit companyId); a string id = that one company. */
  value: string | undefined;
  onChange: (companyId: string | undefined) => void;
  className?: string;
}

export function CompanyScopeSelect({ value, onChange, className }: CompanyScopeSelectProps) {
  const { data, isLoading, error } = useUserCompanies(true);
  const companies: Company[] = data?.companies ?? [];

  // A failed company fetch falls back to the all-my-companies scope, never a blank screen.
  if (error) {
    return (
      <div className={className}>
        <p className="text-xs text-muted-foreground">
          Could not load companies — showing all your companies.
        </p>
      </div>
    );
  }

  return (
    <Select
      value={value ?? ALL}
      onValueChange={(v) => onChange(v === ALL ? undefined : v)}
      disabled={isLoading}
    >
      <SelectTrigger className={className} aria-label="Company scope">
        <SelectValue placeholder={isLoading ? "Loading companies..." : "All my companies"} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={ALL}>All my companies</SelectItem>
        {companies.map((c) => (
          <SelectItem key={c.id} value={c.id}>
            {c.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
