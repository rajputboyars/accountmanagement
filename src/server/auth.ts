import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { hasPermission, validateSessionToken, type SessionContext } from "@/modules/identity";
import { ForbiddenError } from "@/server/errors";
import type { Permission, RoleName } from "@/shared/permissions";

/**
 * Next.js glue for sessions. The browser only ever holds an opaque random token in an httpOnly
 * cookie; who the user is, which shop they belong to and what they may do are always looked up
 * on the server from that token. Nothing the browser sends is trusted for identity.
 */

/** `__Host-` in production: Secure, path=/, no Domain, so subdomains cannot set or read it. */
export function sessionCookieName(): string {
  const base = process.env.SESSION_COOKIE_NAME || "nx_session";
  return process.env.NODE_ENV === "production" ? `__Host-${base}` : base;
}

export async function readSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(sessionCookieName())?.value;
}

/** Validated session for this request (deduplicated per request; never cached across requests). */
export const getCurrentSession = cache(async (): Promise<SessionContext | null> => {
  return validateSessionToken(await readSessionToken());
});

export async function requireSession(): Promise<SessionContext> {
  const session = await getCurrentSession();
  if (!session) redirect("/login");
  return session;
}

/** For pages: returns whether the signed-in user holds the permission (pages then show an access-denied state). */
export async function checkPagePermission(permission: Permission): Promise<{ session: SessionContext; allowed: boolean }> {
  const session = await requireSession();
  return { session, allowed: await hasPermission(session, permission) };
}

/** For server actions: throws ForbiddenError unless the permission is held. */
export async function requireActionPermission(permission: Permission): Promise<SessionContext> {
  const session = await requireSession();
  if (!(await hasPermission(session, permission))) throw new ForbiddenError();
  return session;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  (await cookies()).set(sessionCookieName(), token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: expiresAt,
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(sessionCookieName());
}

/** Where each role lands after signing in. */
export function homePathForRole(role: RoleName): string {
  switch (role) {
    case "owner":
    case "manager":
      return "/dashboard";
    case "cashier":
      return "/billing";
    case "inventory":
      return "/inventory";
  }
}
