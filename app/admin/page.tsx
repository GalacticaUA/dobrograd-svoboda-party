import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ApplicationReview } from "@/components/admin/application-review";
import { Panel } from "@/components/portal/primitives";
import { getSessionProfile, listApplications } from "@/lib/auth/dal";
import { isStaffRole } from "@/types/auth";

/**
 * Administrative portal.
 *
 * A Server Component, so the authorisation check happens during the render that
 * produces the HTML. proxy.ts has already made an optimistic pass, but this is
 * the real one: `getSessionProfile` re-reads the profile from Postgres, so a
 * role revoked a minute ago locks this page immediately rather than in 24 hours.
 *
 * The applicant PII below is passed to the client table only because this check
 * passed. The anon Supabase key exposed to the browser has no RLS policy on
 * `join_applications`, so it could not have fetched these rows even by accident.
 */

export const metadata: Metadata = {
  title: "Панель администратора",
  robots: { index: false, follow: false },
};

/** Always render per request: the output depends on the session cookie. */
export const dynamic = "force-dynamic";

/**
 * Map a session failure to the query string the header notice understands.
 *
 * The distinction matters to the visitor: "sign in first" and "you are signed in
 * but not a member of the council" are different problems with different fixes,
 * and collapsing both into one message sends people to re-authenticate when
 * authentication was never the issue.
 */
const FAILURE_REDIRECT: Record<string, string> = {
  missing: "required",
  invalid: "required",
  expired: "expired",
  unapproved: "pending",
  forbidden: "forbidden",
};

export default async function AdminPage() {
  const session = await getSessionProfile();

  if (!session.ok) {
    redirect(`/?auth=${FAILURE_REDIRECT[session.reason] ?? "required"}`);
  }

  const profile = session.profile;

  if (profile.status !== "approved" || !isStaffRole(profile.role)) {
    // Signed in, but the live row says this account has no standing. The reason
    // reflects the live database, not the token: a user promoted a moment ago is
    // let straight in here.
    redirect(`/?auth=${profile.status === "approved" ? "forbidden" : "pending"}`);
  }

  const applications = await listApplications();

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
      <header className="mb-8">
        <h1 className="font-display text-3xl font-bold text-cloud">Панель администратора</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Заявки на вступление в партию. Действия доступны только совету.
        </p>
      </header>

      <Panel className="p-0 md:p-0">
        <ApplicationReview initialApplications={applications} />
      </Panel>
    </div>
  );
}
