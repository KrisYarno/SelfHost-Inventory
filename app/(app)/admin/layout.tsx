import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { AdminSubNav } from '@/components/admin/admin-sub-nav';

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  // Redirect if not authenticated or not admin
  if (!session || !session.user.isAdmin) {
    redirect('/unauthorized');
  }

  return (
    <div className="flex flex-col gap-6">
      <AdminSubNav />
      {children}
    </div>
  );
}