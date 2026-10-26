import { NextResponse, type NextRequest } from "next/server";

/**
 * Optimistic check only: a request without a session cookie is sent to /login before rendering.
 * It does NOT validate the session. Every private page and action still validates the token on
 * the server (ProtectedPage / requireSession), which is the real security boundary.
 */
export function proxy(request: NextRequest) {
  const base = process.env.SESSION_COOKIE_NAME || "nx_session";
  const cookieName = process.env.NODE_ENV === "production" ? `__Host-${base}` : base;
  if (!request.cookies.has(cookieName)) {
    return NextResponse.redirect(new URL("/login", request.url));
  }
  return NextResponse.next();
}

export const config = {
  // Everything except sign-in, setup, provider webhooks and scheduled jobs (they verify their own
  // signature/secret), Next.js internals and static files.
  matcher: ["/((?!login|setup|api/webhooks|api/jobs|_next/static|_next/image|favicon\\.ico|.*\\.(?:svg|png|jpg|jpeg|ico|webp)$).*)"],
};
