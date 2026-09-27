import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

import { upsertProfileOnSignIn } from "@/lib/auth/dal";
import { missingAuthEnv } from "@/lib/env";
import { clientKey, hit } from "@/lib/auth/rate-limit";
import { createSession } from "@/lib/auth/session";
import { fetchSteamIdentity, verifySteamAssertion } from "@/lib/auth/steam";

/**
 * Step 3 of Steam Web Authentication: verify the assertion and open a session.
 *
 * Security notes on the order of operations:
 *
 *   - The raw callback query string is treated as hostile input throughout. The
 *     `openid.claimed_id` it carries is not evidence of anything on its own.
 *   - verifySteamAssertion replays the assertion to Steam and only returns an id
 *     Steam itself vouches for.
 *   - The profile upsert cannot grant a role or approve an account, so a
 *     first-time visitor cannot reach the portal by signing in repeatedly.
 *   - Rate limited, because a forged-callback flood would otherwise spend the
 *     Steam Web API quota.
 *
 * Redirects, not JSON, because this is a browser navigation. The user never sees
 * this endpoint directly, so the error responses stay deliberately vague.
 */

export const dynamic = "force-dynamic";

/** Where to send the user once authenticated. */
const SUCCESS_REDIRECT = "/";
const FAILURE_REDIRECT = "/?auth=failed";

function fail(request: NextRequest, reason: string): NextResponse {
  return NextResponse.redirect(new URL(`${FAILURE_REDIRECT}&reason=${reason}`, request.url), {
    status: 307,
    // The outcome of this endpoint is a cookie, so nothing downstream may cache
    // it — including a negative result.
    headers: { "cache-control": "no-store" },
  });
}

export async function GET(request: NextRequest) {
  const limit = hit(`steam-callback:${clientKey(request)}`);
  if (!limit.allowed) {
    return NextResponse.redirect(new URL(`${FAILURE_REDIRECT}&reason=rate`, request.url), {
      status: 307,
      headers: { "retry-after": String(limit.retryAfterSeconds), "cache-control": "no-store" },
    });
  }

  // Checked before the round trip to Steam, so an unconfigured deployment costs
  // the user one redirect instead of a login that cannot possibly complete.
  const missing = missingAuthEnv();
  if (missing.length > 0) {
    console.error("[auth] sign-in aborted, env not configured:", missing.join(", "));
    return fail(request, "config");
  }

  // Everything below can fail for reasons that are not the user's fault: Steam
  // being down, a database outage, a write denied by RLS. None of those should
  // surface as a 500 with a stack trace, because the person looking at the
  // screen is a visitor who clicked a button.
  try {
    const steamId = await verifySteamAssertion(request.nextUrl.searchParams);
    if (!steamId) return fail(request, "assertion");

    // Only now is the account known to be genuine, so this is the first moment
    // the Steam Web API key may be spent.
    const identity = await fetchSteamIdentity(steamId);
    if (!identity) return fail(request, "identity");

    const profile = await upsertProfileOnSignIn({
      steamId: identity.steamId,
      persona: identity.persona,
      avatarUrl: identity.avatarUrl,
      realName: identity.realName,
    });

    await createSession(profile);
  } catch (error) {
    // Logged in full for the operator, summarised to the visitor.
    console.error("[auth] sign-in failed:", error);
    return fail(request, "internal");
  }

  // The session cookie is the outcome, so this response must not be cached by an
  // intermediary.
  const response = NextResponse.redirect(new URL(SUCCESS_REDIRECT, request.url));
  response.headers.set("cache-control", "no-store");
  return response;
}
