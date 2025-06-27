'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function PendingApprovalPage() {
  const router = useRouter();
  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');

  const handleResendNotification = async () => {
    setIsResending(true);
    setResendMessage('');
    
    try {
      const response = await fetch('/api/auth/resend-notification', {
        method: 'POST',
      });

      if (response.ok) {
        setResendMessage('Notification sent successfully! An administrator will review your application soon.');
      } else {
        setResendMessage('Failed to send notification. Please try again later.');
      }
    } catch (error) {
      setResendMessage('An error occurred. Please try again later.');
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-surface py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h2 className="mt-6 text-3xl font-extrabold text-foreground">
            Account Pending Approval
          </h2>
          <p className="mt-2 text-sm text-gray-600">
            Your account has been created successfully!
          </p>
        </div>
        
        <div className="rounded-xl bg-warning/10 border border-warning/20 p-6">
          <div className="flex">
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 text-warning"
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden="true"
              >
                <path
                  fillRule="evenodd"
                  d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </div>
            <div className="ml-3">
              <h3 className="text-sm font-medium text-warning">
                Awaiting Administrator Approval
              </h3>
              <div className="mt-2 text-sm text-gray-700">
                <p>
                  Your account is currently pending approval from an administrator.
                  You will receive an email notification once your account has been approved.
                </p>
                <p className="mt-2">
                  This process typically takes 1-2 business days. If you need immediate access,
                  please contact your system administrator.
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-4">
          <div className="text-center">
            <button
              onClick={handleResendNotification}
              disabled={isResending}
              className="w-full sm:w-auto px-6 py-3 bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all font-medium"
            >
              {isResending ? 'Sending...' : 'Resend Notification to Admin'}
            </button>
            
            {resendMessage && (
              <p className={`mt-3 text-sm ${
                resendMessage.includes('successfully') ? 'text-success' : 'text-error'
              }`}>
                {resendMessage}
              </p>
            )}
          </div>

          <div className="text-center">
            <button
              onClick={() => router.push('/auth/signin')}
              className="font-medium text-primary hover:text-primary/80 transition-colors"
            >
              Return to sign in
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}