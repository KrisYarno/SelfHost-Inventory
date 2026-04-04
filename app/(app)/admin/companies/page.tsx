"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toast } from "sonner";
import { Building2, Plus, Pencil, Trash2 } from "lucide-react";
import { useCSRF, withCSRFHeaders } from "@/hooks/use-csrf";

interface Company {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  _count?: {
    users: number;
    integrations: number;
  };
}

export default function AdminCompaniesPage() {
  const router = useRouter();
  const { token: csrfToken } = useCSRF();
  const [companies, setCompanies] = useState<Company[]>([]);
  const [loading, setLoading] = useState(true);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [formData, setFormData] = useState({ name: "", slug: "" });
  const [submitting, setSubmitting] = useState(false);

  const fetchCompanies = useCallback(async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/admin/companies");
      if (!response.ok) {
        if (response.status === 401) {
          router.push("/auth/signin");
          return;
        }
        throw new Error("Failed to fetch companies");
      }
      const data = await response.json();
      setCompanies(data.companies || []);
    } catch (error) {
      console.error("Error fetching companies:", error);
      toast.error("Failed to load companies");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => {
    fetchCompanies();
  }, [fetchCompanies]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);

    try {
      const response = await fetch("/api/admin/companies", {
        method: "POST",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to create company");
      }

      toast.success("Company created successfully");
      setIsCreateDialogOpen(false);
      setFormData({ name: "", slug: "" });
      await fetchCompanies();
    } catch (error) {
      console.error("Error creating company:", error);
      toast.error(error instanceof Error ? error.message : "Failed to create company");
    } finally {
      setSubmitting(false);
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCompany) return;

    setSubmitting(true);

    try {
      const response = await fetch(`/api/admin/companies/${editingCompany.id}`, {
        method: "PUT",
        headers: withCSRFHeaders(
          { "Content-Type": "application/json" },
          csrfToken
        ),
        body: JSON.stringify(formData),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to update company");
      }

      toast.success("Company updated successfully");
      setIsEditDialogOpen(false);
      setEditingCompany(null);
      setFormData({ name: "", slug: "" });
      await fetchCompanies();
    } catch (error) {
      console.error("Error updating company:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update company");
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (company: Company) => {
    if (
      !confirm(
        `Are you sure you want to delete ${company.name}? This will also delete all associated integrations and orders. This action cannot be undone.`
      )
    ) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/companies/${company.id}`, {
        method: "DELETE",
        headers: withCSRFHeaders({}, csrfToken),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Failed to delete company");
      }

      toast.success("Company deleted successfully");
      await fetchCompanies();
    } catch (error) {
      console.error("Error deleting company:", error);
      toast.error(error instanceof Error ? error.message : "Failed to delete company");
    }
  };

  const openEditDialog = (company: Company) => {
    setEditingCompany(company);
    setFormData({ name: company.name, slug: company.slug });
    setIsEditDialogOpen(true);
  };

  const generateSlug = (name: string) => {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  };

  const handleNameChange = (name: string) => {
    setFormData({
      name,
      slug: generateSlug(name),
    });
  };

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div>
            <h1 className="text-3xl font-bold">Companies</h1>
            <p className="text-sm text-muted-foreground">
              Manage companies and their integrations
            </p>
          </div>
          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button>
                <Plus className="mr-2 h-4 w-4" />
                Add Company
              </Button>
            </DialogTrigger>
            <DialogContent>
              <form onSubmit={handleCreate}>
                <DialogHeader>
                  <DialogTitle>Create New Company</DialogTitle>
                  <DialogDescription>
                    Add a new company to the system
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-4 py-4">
                  <div className="space-y-2">
                    <label htmlFor="name" className="text-sm font-medium">
                      Company Name
                    </label>
                    <Input
                      id="name"
                      value={formData.name}
                      onChange={(e) => handleNameChange(e.target.value)}
                      placeholder="Acme Corporation"
                      required
                    />
                  </div>
                  <div className="space-y-2">
                    <label htmlFor="slug" className="text-sm font-medium">
                      Slug
                    </label>
                    <Input
                      id="slug"
                      value={formData.slug}
                      onChange={(e) =>
                        setFormData({ ...formData, slug: e.target.value })
                      }
                      placeholder="acme-corporation"
                      required
                    />
                    <p className="text-xs text-muted-foreground">
                      URL-friendly identifier (auto-generated from name)
                    </p>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsCreateDialogOpen(false);
                      setFormData({ name: "", slug: "" });
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    {submitting ? "Creating..." : "Create Company"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Building2 className="h-5 w-5" />
              All Companies
            </CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <div className="text-center py-8 text-muted-foreground">
                Loading companies...
              </div>
            ) : companies.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No companies found. Create your first company to get started.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Slug</TableHead>
                      <TableHead>Users</TableHead>
                      <TableHead>Integrations</TableHead>
                      <TableHead>Created</TableHead>
                      <TableHead className="text-right">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {companies.map((company) => (
                      <TableRow key={company.id}>
                        <TableCell className="font-medium">
                          {company.name}
                        </TableCell>
                        <TableCell className="font-mono text-sm">
                          {company.slug}
                        </TableCell>
                        <TableCell>
                          {company._count?.users || 0}
                        </TableCell>
                        <TableCell>
                          {company._count?.integrations || 0}
                        </TableCell>
                        <TableCell>
                          {new Date(company.createdAt).toLocaleDateString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => openEditDialog(company)}
                            >
                              <Pencil className="h-3 w-3" />
                            </Button>
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => handleDelete(company)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Edit Dialog */}
      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent>
          <form onSubmit={handleEdit}>
            <DialogHeader>
              <DialogTitle>Edit Company</DialogTitle>
              <DialogDescription>
                Update company information
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label htmlFor="edit-name" className="text-sm font-medium">
                  Company Name
                </label>
                <Input
                  id="edit-name"
                  value={formData.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Acme Corporation"
                  required
                />
              </div>
              <div className="space-y-2">
                <label htmlFor="edit-slug" className="text-sm font-medium">
                  Slug
                </label>
                <Input
                  id="edit-slug"
                  value={formData.slug}
                  onChange={(e) =>
                    setFormData({ ...formData, slug: e.target.value })
                  }
                  placeholder="acme-corporation"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  URL-friendly identifier
                </p>
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsEditDialogOpen(false);
                  setEditingCompany(null);
                  setFormData({ name: "", slug: "" });
                }}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting}>
                {submitting ? "Saving..." : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
