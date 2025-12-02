import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default async function Home() {
  const session = await getSession();

  // Redirect authenticated users to workbench
  if (session?.user?.isApproved) {
    redirect('/workbench');
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-4xl font-extrabold text-foreground">
            Inventory Management System
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Modern inventory tracking and management
          </p>
        </div>
        <div className="mt-8 space-y-4">
          <Link
            href="/auth/signin"
            className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-primary-foreground bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
          >
            Sign In
          </Link>
          <Link
            href="/auth/signup"
            className="w-full flex justify-center py-2 px-4 border border-border text-sm font-medium rounded-md text-foreground bg-surface hover:bg-muted focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
          >
            Create Account
          </Link>
        </div>
      </div>
    </div>
  );
}