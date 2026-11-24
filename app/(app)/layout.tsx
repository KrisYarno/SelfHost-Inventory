import { getSession } from "@/lib/auth";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/layout/app-shell";
import { LocationProvider } from "@/contexts/location-context";
import { ErrorBoundary } from "@/components/error-boundary";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();

  if (!session) {
    // N0 FR2 F1: `reauth=1` tells the middleware NOT to bounce a cookie-holder back
    // to /workbench. Under a sustained DB failure the claims re-read throws, so
    // getServerSession is null while the (uncleared) cookie still looks approved:
    // without the marker, /auth/signin -> /workbench -> /auth/signin loops forever.
    // On the sign-in page the client session fetch clears the stale cookie, or the
    // user signs in normally once the database is back.
    redirect("/auth/signin?reauth=1");
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
