import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { SESSION_COOKIE_NAME } from "@/types/auth";
import { verifySessionToken } from "@/lib/auth/session";

/**
 * Optimistic route guard for the admin portal.
 *
 * This is the first of two layers, and the weaker one. It reads the signed
 * cookie and refuses to serve the page to a visitor who obviously has no
 * business there, which avoids flashing the portal shell to an anonymous user
 * and keeps unauthenticated requests out of the server render.
 *
 * What it deliberately does NOT do, and why:
 *
 *   - It never queries the database. Proxy runs on every matched request,
 *     including prefetches, so a lookup here would slow the whole app and could
 *     not reflect a role change any sooner than the page's own check does.
 *   - It does not mutate cookies. Setting `response.cookies.*` here was tried and
 *     verified to emit no `set-cookie` header at all on Next 16.3.6 — not on a
 *     redirect and not on the pass-through branch. Rather than keep a line that
 *     looks like it clears a stale cookie but silently does not, this file is a
 *     pure read-only gate. Cookie cleanup lives where Next does honour it: the
 *     Steam callback route handler and the Server Actions in
 *     app/lib/auth/actions.ts.
 *
 *     A stale cookie is therefore harmless rather than cleaned: it is rejected
 *     on every request, overwritten by the next successful login, and removed by
 *     an explicit sign-out.
 *   - It is not trusted. The role inside the token is whatever was true at
 *     sign-in, so a downgrade does not take effect here. The real authorisation
 *     is `requireStaff()` in app/lib/auth/dal.ts, called by the page and again by
 *     every Server Action, with the role re-read from Postgres.
 *
 * A user who forges their way past this file reaches a page that immediately
 * queries the DAL and redirects them out again.
 *
 * File name note: `middleware.ts` is deprecated in Next 16 and renamed to
 * `proxy.ts`. It exports a function named `proxy`.
 */

export async function proxy(request: NextRequest) {
  const token = request.cookies.get(SESSION_COOKIE_NAME)?.value;
  const session = await verifySessionToken(token);

  if (!session) {
    // No usable session: send them to the home page with a reason the auth
    // dialog can read, rather than to a login page that does not exist yet.
    const url = request.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    url.searchParams.set("auth", "required");
    return NextResponse.redirect(url);
  }

  // Note what is deliberately NOT here: a `isStaffRole(session.role)` check.
  //
  // An earlier version had one, and it was a real bug. The role inside the token
  // is a snapshot from sign-in, so a user who was `member` when they signed in
  // and was promoted to `admin` a minute later was refused for the remaining 24
  // hours — the proxy bounced them before the page's live database check could
  // ever run. Optimistic guards may only *skip work*, never deny: they must not
  // veto on a value the authoritative check is about to re-read anyway.
  //
  // The real authorisation is `requireStaff()` in app/lib/auth/dal.ts, which the
  // admin page calls during render, re-reading the role from Postgres on every
  // request. The page decides `forbidden` vs `required` from the live result.
  return NextResponse.next();
}

/**
 * Narrow matcher. Without one, Proxy runs on every request including
 * `/_next/static`, `/_next/image` and every image, where an auth redirect would
 * break asset loading. Only the admin surface is guarded.
 *
 * The path must be a static literal: Next parses this at build time and rejects
 * an interpolated template such as `` `${PREFIX}/:path*` ``.
 */
export const config = {
  matcher: ["/admin/:path*"],
};
