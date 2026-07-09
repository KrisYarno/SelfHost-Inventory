"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { UserApprovalCard } from "@/components/admin/user-approval-card";
import { UserTable, User } from "@/components/admin/user-table";
import { EditUserDialog } from "@/components/admin/edit-user-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { CheckCircle2, XCircle, Trash2, Download } from "lucide-react";
import { exportToCSV } from "@/lib/export-utils";
import {
  useAdminPendingUsers,
  useAdminUsers,
  useAdminCompanies,
  useLocationOptions,
  useApproveUser,
  useRejectUser,
  useDeleteUser,
  useBulkApproveUsers,
  useBulkRejectUsers,
  useBulkDeleteUsers,
} from "@/hooks/use-admin";

export default function AdminUsersPage() {
  const router = useRouter();
  const [filter, setFilter] = useState<"all" | "approved" | "pending">("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [selectedUsers, setSelectedUsers] = useState<Set<number>>(new Set());

  // Edit dialog state
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const pendingQuery = useAdminPendingUsers();
  const usersQuery = useAdminUsers({ filter, search, page });
  const { data: locations = [] } = useLocationOptions();
  const { data: companies = [] } = useAdminCompanies();

  const pendingUsers = pendingQuery.data?.users ?? [];
  const allUsers = usersQuery.data?.users ?? [];
  const totalPages = usersQuery.data?.pagination.totalPages ?? 1;
  const loading = usersQuery.isLoading;

  const approveUser = useApproveUser();
  const rejectUser = useRejectUser();
  const deleteUser = useDeleteUser();
  const bulkApprove = useBulkApproveUsers();
  const bulkReject = useBulkRejectUsers();
  const bulkDelete = useBulkDeleteUsers();
  const bulkLoading = bulkApprove.isPending || bulkReject.isPending || bulkDelete.isPending;

  // Preserve the original 401 -> signin redirect (was on the pending fetch).
  useEffect(() => {
    if (pendingQuery.error?.status === 401 || usersQuery.error?.status === 401) {
      router.push("/auth/signin");
    }
  }, [pendingQuery.error, usersQuery.error, router]);

  const handleEdit = (user: User) => {
    setEditingUser(user);
    setEditDialogOpen(true);
  };

  // Refresh is handled by useUpdateUser's cache invalidation inside the dialog.
  const handleEditSuccess = () => {};

  const handleApprove = async (userId: number) => {
    try {
      await approveUser.mutateAsync(userId);
      toast.success("User approved successfully");
    } catch (error) {
      console.error("Error approving user:", error);
      toast.error("Failed to approve user");
    }
  };

  const handleReject = async (userId: number, reason?: string) => {
    try {
      await rejectUser.mutateAsync({ userId, reason });
      toast.success("User rejected successfully");
    } catch (error) {
      console.error("Error rejecting user:", error);
      toast.error("Failed to reject user");
    }
  };

  const handleDelete = async (userId: number) => {
    if (!confirm("Are you sure you want to delete this user? This action cannot be undone.")) {
      return;
    }

    try {
      await deleteUser.mutateAsync(userId);
      toast.success("User deleted successfully");
    } catch (error) {
      console.error("Error deleting user:", error);
      toast.error("Failed to delete user");
    }
  };


  const handleBulkApprove = async () => {
    if (selectedUsers.size === 0) {
      toast.error("No users selected");
      return;
    }

    try {
      const result = await bulkApprove.mutateAsync(Array.from(selectedUsers));
      toast.success(`Successfully approved ${result.approved} users`);
      setSelectedUsers(new Set());
    } catch (error) {
      console.error("Error bulk approving users:", error);
      toast.error("Failed to approve users");
    }
  };

  const handleBulkReject = async () => {
    if (selectedUsers.size === 0) {
      toast.error("No users selected");
      return;
    }

    if (!confirm(`Are you sure you want to reject ${selectedUsers.size} users?`)) {
      return;
    }

    try {
      const result = await bulkReject.mutateAsync(Array.from(selectedUsers));
      toast.success(`Successfully rejected ${result.rejected} users`);
      setSelectedUsers(new Set());
    } catch (error) {
      console.error("Error bulk rejecting users:", error);
      toast.error("Failed to reject users");
    }
  };

  const handleBulkDelete = async () => {
    if (selectedUsers.size === 0) {
      toast.error("No users selected");
      return;
    }

    if (!confirm(`Are you sure you want to delete ${selectedUsers.size} users? This action cannot be undone.`)) {
      return;
    }

    try {
      const result = await bulkDelete.mutateAsync(Array.from(selectedUsers));
      toast.success(`Successfully deleted ${result.deleted} users`);
      setSelectedUsers(new Set());
    } catch (error) {
      console.error("Error bulk deleting users:", error);
      toast.error("Failed to delete users");
    }
  };

  const handleExportCSV = () => {
    if (allUsers.length === 0) return;
    exportToCSV(
      allUsers,
      [
        { key: "username", label: "Username" },
        { key: "email", label: "Email" },
        { key: "isAdmin", label: "Admin" },
        { key: "isApproved", label: "Approved" },
      ],
      `users-${new Date().toISOString().split("T")[0]}.csv`
    );
  };

  const toggleUserSelection = (userId: number) => {
    const newSelection = new Set(selectedUsers);
    if (newSelection.has(userId)) {
      newSelection.delete(userId);
    } else {
      newSelection.add(userId);
    }
    setSelectedUsers(newSelection);
  };

  const selectAllPending = () => {
    const pendingIds = allUsers.filter((user) => !user.isApproved).map((user) => user.id);
    setSelectedUsers(new Set(pendingIds));
  };

  return (
    <div className="flex flex-col h-full overflow-x-hidden">
      {/* Header */}
      <div className="container mx-auto p-4 sm:p-6 space-y-6 min-w-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 min-w-0">
          <div>
            <h1 className="text-3xl font-bold">User Management</h1>
            <p className="text-sm text-muted-foreground">Manage user approvals and access levels</p>
          </div>
          {selectedUsers.size === 0 && allUsers.length > 0 && (
            <Button variant="outline" size="sm" onClick={handleExportCSV}>
              <Download className="h-4 w-4" />
              <span className="hidden sm:inline ml-1">Export CSV</span>
            </Button>
          )}
          {selectedUsers.size > 0 && (() => {
            const selectedUsersList = allUsers.filter(u => selectedUsers.has(u.id));
            const pendingCount = selectedUsersList.filter(u => !u.isApproved).length;
            const approvedCount = selectedUsersList.filter(u => u.isApproved).length;

            return (
              <div className="flex gap-2 flex-wrap">
                {pendingCount > 0 && (
                  <>
                    <Button onClick={handleBulkApprove} disabled={bulkLoading} variant="default">
                      <CheckCircle2 className="mr-2 h-4 w-4" />
                      Approve {pendingCount}
                    </Button>
                    <Button onClick={handleBulkReject} disabled={bulkLoading} variant="outline">
                      <XCircle className="mr-2 h-4 w-4" />
                      Reject {pendingCount}
                    </Button>
                  </>
                )}
                {approvedCount > 0 && (
                  <Button onClick={handleBulkDelete} disabled={bulkLoading} variant="destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete {approvedCount}
                  </Button>
                )}
              </div>
            );
          })()}
        </div>

        {/* Pending Approvals Section */}
        {pendingUsers.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Pending Approvals ({pendingUsers.length})</span>
                {pendingUsers.length > 1 && (
                  <Button size="sm" variant="outline" onClick={selectAllPending}>
                    Select All Pending
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {pendingUsers.map((user) => (
                  <UserApprovalCard
                    key={user.id}
                    user={user}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    isSelected={selectedUsers.has(user.id)}
                    onToggleSelect={() => toggleUserSelection(user.id)}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* All Users Section */}
        <Card>
          <CardHeader>
            <CardTitle>All Users</CardTitle>
            <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 mt-4 min-w-0">
              <div className="flex gap-2 flex-wrap">
                <Button
                  onClick={() => {
                    setFilter("all");
                    setPage(1);
                  }}
                  variant={filter === "all" ? "default" : "outline"}
                  size="sm"
                >
                  All Users
                </Button>
                <Button
                  onClick={() => {
                    setFilter("approved");
                    setPage(1);
                  }}
                  variant={filter === "approved" ? "default" : "outline"}
                  size="sm"
                >
                  Approved
                </Button>
                <Button
                  onClick={() => {
                    setFilter("pending");
                    setPage(1);
                  }}
                  variant={filter === "pending" ? "default" : "outline"}
                  size="sm"
                >
                  Pending
                </Button>
              </div>

              <div className="flex-1 max-w-md min-w-0">
                <Input
                  type="text"
                  placeholder="Search by email or username..."
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                />
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Enhanced Users Table */}
            <UserTable
              users={allUsers}
              loading={loading}
              onApprove={handleApprove}
              onReject={handleReject}
              onDelete={handleDelete}
              onEdit={handleEdit}
              selectedUsers={selectedUsers}
              onToggleSelect={toggleUserSelection}
            />

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-6 flex justify-center gap-2">
                <Button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  variant="outline"
                  size="sm"
                >
                  Previous
                </Button>
                <span className="px-4 py-2 text-sm">
                  Page {page} of {totalPages}
                </span>
                <Button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  variant="outline"
                  size="sm"
                >
                  Next
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Edit User Dialog */}
      <EditUserDialog
        user={editingUser}
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        onSuccess={handleEditSuccess}
        locations={locations}
        companies={companies}
      />
    </div>
  );
}
