import { NextResponse } from "next/server";

import { buildSteamLoginUrl } from "@/lib/auth/steam";
import { missingAuthEnv } from "@/lib/env";

/**
 * Step 1 of Steam Web Authentication: hand the browser to Steam.
 *
 * A GET route rather than a Server Action, because the flow is a plain
 * navigation and a user who bookmarks or refreshes the sign-in link should be
 * able to restart it.
 *
 * Always dynamic: the redirect target is built per request, and this route must
 * never be statically optimised or cached.
 */
export const dynamic = "force-dynamic";

export function GET() {
  // Refuse before leaving the site if the callback could not finish the job.
  // Without this the visitor authenticates against Steam successfully and is
  // then dropped back here into a failure, which looks like Steam is broken
  // rather than like the deployment is missing a key.
  const missing = missingAuthEnv();
  if (missing.length > 0) {
    console.error("[auth] sign-in refused, env not configured:", missing.join(", "));
    return NextResponse.redirect(
      new URL("/?auth=failed&reason=config", process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000"),
      { status: 307, headers: { "cache-control": "no-store" } },
    );
  }

  return NextResponse.redirect(buildSteamLoginUrl(), {
    // 307 preserves the method and, more importantly here, prevents any
    // intermediate cache from serving a stale redirect.
    status: 307,
    headers: { "cache-control": "no-store" },
  });
}
