import type { SessionFailure } from "@/types/auth";

/**
 * "Your session is not good enough" — absent, stale, or lacking a permission.
 *
 * This lives in its own module rather than in `app/lib/auth/dal.ts` for one
 * reason: `app/lib/permissions/effective.ts` has to throw it, and the auth DAL
 * has to call into the permission resolver. Keeping the class in the DAL would
 * make those two import each other.
 *
 * It is re-exported from the DAL, so existing `import { SessionError } from
 * "@/lib/auth/dal"` keeps working and the Server Action layer that catches it does
 * not need to know which file the class came from.
 */
export class SessionError extends Error {
  readonly reason: SessionFailure;

  constructor(reason: SessionFailure) {
    super(`Session rejected: ${reason}`);
    this.name = "SessionError";
    this.reason = reason;
  }
}
