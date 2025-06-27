import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const session = await getSession();

  if (!session) {
    redirect('/auth/signin');
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="border-b border-border bg-background px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
            <p className="text-sm text-muted-foreground">
              Welcome back, {session.user.email?.split('@')[0]}
            </p>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 p-6">
        <div className="mx-auto max-w-7xl">
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="text-lg font-semibold mb-4">Account Information</h2>
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Email:</span>
                <span className="text-sm font-medium">{session.user.email}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">User ID:</span>
                <span className="text-sm font-mono">{session.user.id}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Role:</span>
                <span className="text-sm font-medium">{session.user.isAdmin ? 'Admin' : 'User'}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Status:</span>
                <span className="text-sm font-medium">{session.user.isApproved ? 'Approved' : 'Pending Approval'}</span>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}