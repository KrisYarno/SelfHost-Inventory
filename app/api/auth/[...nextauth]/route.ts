import NextAuth from "next-auth";
import { authOptions } from "@/lib/auth";

const handler = NextAuth(authOptions);

type NextAuthContext = { params: { nextauth?: string[] } };

// N0 FR3 G1: setting `authOptions.logger` switches on next-auth's `_log` action
// (core/index.js): an UNAUTHENTICATED, CSRF-free POST whose body picks the log
// level and the code, unthrottled (the middleware skips api/auth). Nothing here
// uses client-side logging, so it is answered 204 BEFORE NextAuth runs — the same
// first catch-all segment NextAuth reads as its action. Everything else is
// delegated unchanged.
async function POST(req: Request, context: NextAuthContext) {
  const params = await context.params;
  if (params?.nextauth?.[0] === "_log") {
    return new Response(null, { status: 204 });
  }
  return handler(req, context);
}

export { handler as GET, POST };
