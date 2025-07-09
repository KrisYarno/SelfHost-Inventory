import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { LocationProvider } from "@/contexts/location-context";
import { ErrorBoundary } from "@/components/error-boundary";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();

  if (!session) {
    redirect("/auth/signin");
  }

  if (!session.user.isApproved) {
    redirect("/auth/pending-approval");
  }

  return (
    <LocationProvider>
      <ErrorBoundary>
        <AppShell>{children}</AppShell>
      </ErrorBoundary>
    </LocationProvider>
  );
}