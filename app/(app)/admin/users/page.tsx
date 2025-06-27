'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { UserApprovalCard } from '@/components/admin/user-approval-card';
import { UserTable } from '@/components/admin/user-table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { toast } from 'sonner';
import { CheckCircle2, XCircle, UserCog } from 'lucide-react';

interface User {
  id: number;
  email: string;
  username: string;
  isAdmin: boolean;
  isApproved: boolean;
}

interface UsersResponse {
  users: User[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export default function AdminUsersPage() {
  const router = useRouter();
  const [pendingUsers, setPendingUsers] = useState<User[]>([]);
  const [allUsers, setAllUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'approved' | 'pending'>('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedUsers, setSelectedUsers] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  const fetchUsers = useCallback(async () => {
    try {
      setLoading(true);
      
      // Fetch pending users for the approval cards
      const pendingResponse = await fetch('/api/admin/users?filter=pending&limit=100');
      if (!pendingResponse.ok) {
        if (pendingResponse.status === 401) {
          router.push('/auth/signin');
          return;
        }
        throw new Error('Failed to fetch pending users');
      }
      const pendingData: UsersResponse = await pendingResponse.json();
      setPendingUsers(pendingData.users);

      // Fetch filtered users for the table
      const params = new URLSearchParams({
        filter,
        page: page.toString(),
        limit: '10',
      });
      if (search) params.append('search', search);
      
      const allResponse = await fetch(`/api/admin/users?${params}`);
      if (!allResponse.ok) {
        throw new Error('Failed to fetch users');
      }
      const allData: UsersResponse = await allResponse.json();
      setAllUsers(allData.users);
      setTotalPages(allData.pagination.totalPages);
    } catch (error) {
      console.error('Error fetching users:', error);
    } finally {
      setLoading(false);
    }
  }, [filter, search, page, router]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleApprove = async (userId: number) => {
    try {
      const response = await fetch(`/api/admin/users/${userId}/approve`, {
        method: 'POST',
      });

      if (!response.ok) {
        throw new Error('Failed to approve user');
      }

      // Refresh the user lists
      await fetchUsers();
      toast.success('User approved successfully');
    } catch (error) {
      console.error('Error approving user:', error);
      toast.error('Failed to approve user');
    }
  };

  const handleReject = async (userId: number, reason?: string) => {
    try {
      const response = await fetch(`/api/admin/users/${userId}/reject`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason }),
      });

      if (!response.ok) {
        throw new Error('Failed to reject user');
      }

      // Refresh the user lists
      await fetchUsers();
      toast.success('User rejected successfully');
    } catch (error) {
      console.error('Error rejecting user:', error);
      toast.error('Failed to reject user');
    }
  };

  const handleDelete = async (userId: number) => {
    if (!confirm('Are you sure you want to delete this user? This action cannot be undone.')) {
      return;
    }

    try {
      const response = await fetch(`/api/admin/users/${userId}`, {
        method: 'DELETE',
      });

      if (!response.ok) {
        throw new Error('Failed to delete user');
      }

      toast.success('User deleted successfully');
      await fetchUsers();
    } catch (error) {
      console.error('Error deleting user:', error);
      toast.error('Failed to delete user');
    }
  };

  const handleToggleAdmin = async (userId: number, currentIsAdmin: boolean) => {
    try {
      const response = await fetch(`/api/admin/users/${userId}/toggle-admin`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ isAdmin: !currentIsAdmin }),
      });

      if (!response.ok) {
        throw new Error('Failed to update user role');
      }

      toast.success(`User role updated to ${!currentIsAdmin ? 'Admin' : 'User'}`);
      await fetchUsers();
    } catch (error) {
      console.error('Error updating user role:', error);
      toast.error('Failed to update user role');
    }
  };

  const handleBulkApprove = async () => {
    if (selectedUsers.size === 0) {
      toast.error('No users selected');
      return;
    }

    setBulkLoading(true);
    try {
      const response = await fetch('/api/admin/users/bulk-approve', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userIds: Array.from(selectedUsers) }),
      });

      if (!response.ok) {
        throw new Error('Failed to approve users');
      }

      const result = await response.json();
      toast.success(`Successfully approved ${result.approved} users`);
      setSelectedUsers(new Set());
      await fetchUsers();
    } catch (error) {
      console.error('Error bulk approving users:', error);
      toast.error('Failed to approve users');
    } finally {
      setBulkLoading(false);
    }
  };

  const handleBulkReject = async () => {
    if (selectedUsers.size === 0) {
      toast.error('No users selected');
      return;
    }

    if (!confirm(`Are you sure you want to reject ${selectedUsers.size} users?`)) {
      return;
    }

    setBulkLoading(true);
    try {
      const response = await fetch('/api/admin/users/bulk-reject', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userIds: Array.from(selectedUsers) }),
      });

      if (!response.ok) {
        throw new Error('Failed to reject users');
      }

      const result = await response.json();
      toast.success(`Successfully rejected ${result.rejected} users`);
      setSelectedUsers(new Set());
      await fetchUsers();
    } catch (error) {
      console.error('Error bulk rejecting users:', error);
      toast.error('Failed to reject users');
    } finally {
      setBulkLoading(false);
    }
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
    const pendingIds = allUsers
      .filter(user => !user.isApproved)
      .map(user => user.id);
    setSelectedUsers(new Set(pendingIds));
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="container mx-auto p-6 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-3xl font-bold">User Management</h1>
            <p className="text-sm text-muted-foreground">
              Manage user approvals and access levels
            </p>
          </div>
          {selectedUsers.size > 0 && (
            <div className="flex gap-2">
              <Button
                onClick={handleBulkApprove}
                disabled={bulkLoading}
                variant="default"
              >
                <CheckCircle2 className="mr-2 h-4 w-4" />
                Approve {selectedUsers.size} Users
              </Button>
              <Button
                onClick={handleBulkReject}
                disabled={bulkLoading}
                variant="destructive"
              >
                <XCircle className="mr-2 h-4 w-4" />
                Reject {selectedUsers.size} Users
              </Button>
            </div>
          )}
        </div>

        {/* Pending Approvals Section */}
        {pendingUsers.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center justify-between">
                <span>Pending Approvals ({pendingUsers.length})</span>
                {pendingUsers.length > 1 && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={selectAllPending}
                  >
                    Select All Pending
                  </Button>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
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
            <div className="flex flex-col sm:flex-row gap-4 mt-4">
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    setFilter('all');
                    setPage(1);
                  }}
                  variant={filter === 'all' ? 'default' : 'outline'}
                  size="sm"
                >
                  All Users
                </Button>
                <Button
                  onClick={() => {
                    setFilter('approved');
                    setPage(1);
                  }}
                  variant={filter === 'approved' ? 'default' : 'outline'}
                  size="sm"
                >
                  Approved
                </Button>
                <Button
                  onClick={() => {
                    setFilter('pending');
                    setPage(1);
                  }}
                  variant={filter === 'pending' ? 'default' : 'outline'}
                  size="sm"
                >
                  Pending
                </Button>
              </div>
              
              <div className="flex-1 max-w-md">
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
              onToggleAdmin={handleToggleAdmin}
              selectedUsers={selectedUsers}
              onToggleSelect={toggleUserSelection}
            />

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="mt-6 flex justify-center gap-2">
                <Button
                  onClick={() => setPage(p => Math.max(1, p - 1))}
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
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
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
    </div>
  );
}