import Link from 'next/link';

export default function UnauthorizedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <h1 className="text-6xl font-extrabold text-foreground">403</h1>
          <h2 className="mt-2 text-3xl font-bold text-foreground">
            Unauthorized Access
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            You don&apos;t have permission to access this resource.
          </p>
        </div>
        <div className="mt-8">
          <Link
            href="/dashboard"
            className="w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-primary-foreground bg-primary hover:bg-primary/90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
          >
            Return to Dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}