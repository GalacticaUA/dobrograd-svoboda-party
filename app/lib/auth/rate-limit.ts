import "server-only";

/**
 * Fixed-window rate limiter for the authentication routes.
 *
 * In-memory by design, and that is an honest limitation rather than an oversight:
 * it resets when the process restarts and is per-instance, so on a multi-instance
 * or serverless deployment each instance keeps its own counters. It still does
 * the job that matters here — stopping a single client from hammering the Steam
 * Web API, which is a shared metered resource — and it does it without adding a
 * Redis dependency or a round trip.
 *
 * If the deployment is horizontally scaled, swap `hit()` for a store shared
 * across instances (Upstash, Redis, or a Postgres table) and keep the interface.
 */

interface Window {
  count: number;
  /** Epoch milliseconds at which this window expires. */
  resetAt: number;
}

const WINDOW_MS = 60_000;
const MAX_HITS = 10;

/**
 * Bounded map: an attacker rotating source addresses must not be able to grow
 * this without limit, so expired entries are swept on write.
 */
const windows = new Map<string, Window>();

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function hit(key: string): RateLimitResult {
  const now = Date.now();

  if (windows.size > 5_000) {
    for (const [existing, window] of windows) {
      if (window.resetAt <= now) windows.delete(existing);
    }
  }

  const current = windows.get(key);

  if (!current || current.resetAt <= now) {
    windows.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  current.count += 1;

  if (current.count > MAX_HITS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000)),
    };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Identify the caller for rate-limiting purposes.
 *
 * The `x-forwarded-for` header is attacker-controlled unless a trusted proxy
 * overwrites it, so this is only ever used to throttle — never to make an
 * authorisation decision.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]!.trim();

  return request.headers.get("x-real-ip") ?? "unknown";
}
