'use client';

import { signOut } from 'next-auth/react';

interface SignOutButtonProps {
  className?: string;
}

export function SignOutButton({ className }: SignOutButtonProps) {
  const handleSignOut = () => {
    signOut({ callbackUrl: '/' });
  };

  return (
    <button
      onClick={handleSignOut}
      className={className || 'text-foreground/80 hover:text-foreground'}
    >
      Sign Out
    </button>
  );
}