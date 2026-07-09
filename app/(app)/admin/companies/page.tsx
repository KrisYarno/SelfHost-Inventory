"use client";

import { useEffect, useState } from "react";
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
import {
  useAdminCompanies,
  useCreateCompany,
  useUpdateCompany,
  useDeleteCompany,
  type AdminCompany as Company,
} from "@/hooks/use-admin";

export default function AdminCompaniesPage() {
  const router = useRouter();
  const { data: companies = [], isLoading: loading, error } = useAdminCompanies();
  const createCompany = useCreateCompany();
  const updateCompany = useUpdateCompany();
  const deleteCompany = useDeleteCompany();
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingCompany, setEditingCompany] = useState<Company | null>(null);
  const [formData, setFormData] = useState({ name: "", slug: "" });
  const submitting = createCompany.isPending || updateCompany.isPending;

  // Preserve the original 401 -> signin redirect and load-failure toast.
  useEffect(() => {
    if (error?.status === 401) {
      router.push("/auth/signin");
    } else if (error) {
      toast.error("Failed to load companies");
    }
  }, [error, router]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();

    try {
      await createCompany.mutateAsync(formData);
      toast.success("Company created successfully");
      setIsCreateDialogOpen(false);
      setFormData({ name: "", slug: "" });
    } catch (error) {
      console.error("Error creating company:", error);
      toast.error(error instanceof Error ? error.message : "Failed to create company");
    }
  };

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingCompany) return;

    try {
      await updateCompany.mutateAsync({ id: editingCompany.id, formData });
      toast.success("Company updated successfully");
      setIsEditDialogOpen(false);
      setEditingCompany(null);
      setFormData({ name: "", slug: "" });
    } catch (error) {
      console.error("Error updating company:", error);
      toast.error(error instanceof Error ? error.message : "Failed to update company");
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
      await deleteCompany.mutateAsync(company.id);
      toast.success("Company deleted successfully");
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
