import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { ApplicationReview } from "@/components/admin/application-review";
import { PeopleTable } from "@/components/admin/people-table";
import { RoleManager } from "@/components/admin/role-manager";
import { Panel } from "@/components/portal/primitives";
import { getSessionProfile, listProfiles, listSignInRequests } from "@/lib/auth/dal";
import { listCustomRoles } from "@/lib/portal/dal";
import { getEffectivePermissions, grantableActions } from "@/lib/permissions/effective";

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
  const permissions = await getEffectivePermissions(profile);

  // `application.review` is the entry point this page is actually for, so it is
  // the gate. It replaced `isStaffRole`, which asked "is the built-in role on the
  // staff list" and therefore could not see a database role that grants it — the
  // whole reason this check moved off the role column.
  if (profile.status !== "approved" || !permissions.includes("application.review")) {
    // Signed in, but the live row says this account has no standing. The reason
    // reflects the live database, not the token: a user promoted a moment ago is
    // let straight in here.
    redirect(`/?auth=${profile.status === "approved" ? "forbidden" : "pending"}`);
  }

  const requests = await listSignInRequests();
  const profiles = await listProfiles();

  // The role editor is a second gate on top of the first: reaching /admin needs
  // `application.review`, but editing roles needs `profile.grantRole`. A staff
  // member can review applications and not be able to hand out permissions, so
  // the section is omitted rather than rendered-and-rejected.
  const mayGrantRoles = permissions.includes("profile.grantRole");
  const [roles, grantable] = mayGrantRoles
    ? await Promise.all([listCustomRoles(), grantableActions(profile)])
    : [[], []];

  return (
    <div className="mx-auto max-w-7xl px-5 py-12 sm:px-8">
      <header className="mb-8">
        <h1 className="font-display text-3xl font-bold text-cloud">Панель администратора</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Заявки на вход через Steam и все аккаунты партии. Действия доступны только совету.
        </p>
      </header>

      <div className="space-y-4">
        <section aria-labelledby="admin-requests">
          <h2 id="admin-requests" className="font-display text-xl font-bold text-cloud">
            Заявки на вход
          </h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">
            Аккаунты, созданные при первом входе через Steam, и ждут решения.
          </p>

          <Panel className="p-0 md:p-0">
            <ApplicationReview initialApplications={requests} />
          </Panel>
        </section>

        <section aria-labelledby="admin-people">
          <h2 id="admin-people" className="font-display text-xl font-bold text-cloud">
            Люди
          </h2>
          <p className="mt-1 mb-4 text-sm text-muted-foreground">
            Все, кто вошёл через Steam. Роль, исключение и часы.
          </p>

          <Panel className="p-0 md:p-0">
            <PeopleTable
              initialProfiles={profiles}
              permissions={permissions}
              viewerSteamId={profile.steamId}
              viewerRoles={profile.roles}
            />
          </Panel>
        </section>

        {mayGrantRoles ? (
          <section aria-labelledby="admin-roles">
            <h2 id="admin-roles" className="font-display text-xl font-bold text-cloud">
              Роли
            </h2>
            <p className="mt-1 mb-4 text-sm text-muted-foreground">
              Встроенные роли назначаются одним кликом из списка участников. Ниже — наборы дополнительных
              прав, которые выдаются поверх встроенной роли.
            </p>

            <Panel className="p-0 md:p-0">
              <RoleManager
                initialRoles={roles}
                grantable={grantable}
                profiles={profiles}
                viewerRoles={profile.roles}
              />
            </Panel>
          </section>
        ) : null}
      </div>
    </div>
  );
}
