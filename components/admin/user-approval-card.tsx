'use client';

import { useState } from 'react';

interface User {
  id: number;
  email: string;
  username: string;
  isAdmin: boolean;
  isApproved: boolean;
}

interface UserApprovalCardProps {
  user: User;
  onApprove: (userId: number) => Promise<void>;
  onReject: (userId: number, reason?: string) => Promise<void>;
  isSelected?: boolean;
  onToggleSelect?: () => void;
}

export function UserApprovalCard({ user, onApprove, onReject, isSelected, onToggleSelect }: UserApprovalCardProps) {
  const [isProcessing, setIsProcessing] = useState(false);
  const [showRejectDialog, setShowRejectDialog] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const handleApprove = async () => {
    setIsProcessing(true);
    try {
      await onApprove(user.id);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleReject = async () => {
    setIsProcessing(true);
    try {
      await onReject(user.id, rejectReason || undefined);
      setShowRejectDialog(false);
      setRejectReason('');
    } finally {
      setIsProcessing(false);
    }
  };

  // Since we don't have createdAt, we'll skip showing registration date

  return (
    <>
      <div className={`bg-card border ${isSelected ? 'border-primary' : 'border-border'} rounded-lg p-6 hover:shadow-md transition-shadow relative`}>
        {onToggleSelect && (
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="absolute top-4 left-4 h-4 w-4 text-primary rounded border-border focus:ring-primary"
          />
        )}
        <div className={`flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 ${onToggleSelect ? 'ml-6' : ''}`}>
          <div className="flex-1">
            <h3 className="font-semibold text-lg text-foreground">{user.username}</h3>
            <p className="text-sm text-muted-foreground mt-1">{user.email}</p>
            <div className="mt-3 space-y-1">
              <p className="text-sm">
                <span className="text-muted-foreground">Role:</span>{' '}
                <span className="font-medium">{user.isAdmin ? 'Admin' : 'User'}</span>
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">Status:</span>{' '}
                <span className="font-medium">{user.isApproved ? 'Approved' : 'Pending Approval'}</span>
              </p>
            </div>
          </div>
          <div className="flex flex-col sm:flex-row gap-2">
            <button
              onClick={handleApprove}
              disabled={isProcessing}
              className="px-4 py-2 bg-success text-white rounded-lg hover:bg-success/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              {isProcessing ? 'Processing...' : 'Approve'}
            </button>
            <button
              onClick={() => setShowRejectDialog(true)}
              disabled={isProcessing}
              className="px-4 py-2 bg-error text-white rounded-lg hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
            >
              Reject
            </button>
          </div>
        </div>
      </div>

      {/* Reject Dialog */}
      {showRejectDialog && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-card rounded-lg p-6 max-w-md w-full border border-border">
            <h3 className="text-lg font-semibold mb-4">Reject User Application</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Are you sure you want to reject {user.username}&apos;s application?
            </p>
            <div className="mb-4">
              <label htmlFor="reason" className="block text-sm font-medium text-foreground mb-2">
                Reason (optional)
              </label>
              <textarea
                id="reason"
                value={rejectReason}
                onChange={(e) => setRejectReason(e.target.value)}
                className="w-full px-3 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary bg-background text-foreground"
                rows={3}
                placeholder="Provide a reason for rejection..."
              />
            </div>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => {
                  setShowRejectDialog(false);
                  setRejectReason('');
                }}
                disabled={isProcessing}
                className="px-4 py-2 text-foreground bg-muted rounded-lg hover:bg-muted/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
              >
                Cancel
              </button>
              <button
                onClick={handleReject}
                disabled={isProcessing}
                className="px-4 py-2 bg-error text-white rounded-lg hover:bg-error/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors text-sm font-medium"
              >
                {isProcessing ? 'Rejecting...' : 'Confirm Rejection'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}