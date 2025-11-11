'use client';

import { DataTable } from '@/components/ui/data-table';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { UserCog, MoreHorizontal, Check, X, Trash2 } from 'lucide-react';

interface User {
  id: number;
  email: string;
  username: string;
  isAdmin: boolean;
  isApproved: boolean;
}

interface UserTableProps {
  users: User[];
  loading?: boolean;
  onApprove?: (userId: number) => Promise<void>;
  onReject?: (userId: number) => Promise<void>;
  onDelete?: (userId: number) => Promise<void>;
  onToggleAdmin?: (userId: number, currentIsAdmin: boolean) => Promise<void>;
  selectedUsers?: Set<number>;
  onToggleSelect?: (userId: number) => void;
}

export function UserTable({ 
  users, 
  loading, 
  onApprove, 
  onReject, 
  onDelete,
  onToggleAdmin,
  selectedUsers,
  onToggleSelect 
}: UserTableProps) {
  const handleAction = async (action: 'approve' | 'reject', userId: number) => {
    if (action === 'approve' && onApprove) {
      await onApprove(userId);
    } else if (action === 'reject' && onReject) {
      await onReject(userId);
    }
  };

  const columns = [
    ...(selectedUsers && onToggleSelect ? [{
      key: 'select',
      header: '',
      width: '40px',
      cell: (item: Record<string, unknown>) => {
        const user = item as unknown as User;
        return (
        <Checkbox
          checked={selectedUsers.has(user.id)}
          onCheckedChange={() => onToggleSelect(user.id)}
          disabled={user.isApproved}
        />
      )},
    }] : []),
    {
      key: 'username',
      header: 'Username',
      cell: (item: Record<string, unknown>) => {
        const user = item as unknown as User;
        return (
        <div className="min-w-0">
          <p className="font-medium truncate max-w-[60vw] sm:max-w-none">{user.username}</p>
          <p className="text-xs sm:text-sm text-muted-foreground break-all sm:break-normal truncate max-w-[70vw] sm:max-w-none">{user.email}</p>
        </div>
      )},
    },
    {
      key: 'role',
      header: 'Role',
      cell: (item: Record<string, unknown>) => {
        const user = item as unknown as User;
        return (
        <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
          user.isAdmin 
            ? 'bg-primary/10 text-primary' 
            : 'bg-muted text-muted-foreground'
        }`}>
          {user.isAdmin ? 'Admin' : 'User'}
        </span>
      )},
    },
    {
      key: 'status',
      header: 'Status',
      cell: (item: Record<string, unknown>) => {
        const user = item as unknown as User;
        return (
        <span className={`inline-flex px-2 py-1 text-xs font-medium rounded-full ${
          user.isApproved 
            ? 'bg-success/10 text-success' 
            : 'bg-warning/10 text-warning'
        }`}>
          {user.isApproved ? 'Approved' : 'Pending'}
        </span>
      )},
    },
    {
      key: 'actions',
      header: 'Actions',
      cell: (item: Record<string, unknown>) => {
        const user = item as unknown as User;
        return (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm" className="h-8 w-8 p-0">
                <span className="sr-only">Open menu</span>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[12rem] sm:min-w-[14rem] max-w-[90vw]">
              {!user.isApproved && (
                <>
                  {onApprove && (
                    <DropdownMenuItem onClick={() => handleAction('approve', user.id)}>
                      <Check className="mr-2 h-4 w-4 text-success" />
                      <span>Approve User</span>
                    </DropdownMenuItem>
                  )}
                  {onReject && (
                    <DropdownMenuItem onClick={() => handleAction('reject', user.id)}>
                      <X className="mr-2 h-4 w-4 text-warning" />
                      <span>Reject User</span>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuSeparator />
                </>
              )}
              {user.isApproved && onToggleAdmin && (
                <DropdownMenuItem onClick={() => onToggleAdmin(user.id, user.isAdmin)}>
                  <UserCog className="mr-2 h-4 w-4" />
                  <span>{user.isAdmin ? "Remove Admin" : "Make Admin"}</span>
                </DropdownMenuItem>
              )}
              {onDelete && (
                <>
                  {(user.isApproved && onToggleAdmin) && <DropdownMenuSeparator />}
                  <DropdownMenuItem 
                    onClick={() => onDelete(user.id)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    <span>Delete User</span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        );
      },
    },
  ];

  return (
    <DataTable
      data={users as unknown as Record<string, unknown>[]}
      columns={columns}
      loading={loading}
      emptyMessage="No users found"
      className="bg-card rounded-lg border border-border"
    />
  );
}
