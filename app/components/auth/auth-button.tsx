import { AuthDialog } from "@/components/auth/auth-dialog";
import { getSessionProfile } from "@/lib/auth/dal";
import { getEffectivePermissions } from "@/lib/permissions/effective";
import type { ProfileDTO } from "@/types/auth";

/**
 * Server component that resolves the current session and hands it to the
 * client dialog.
 *
 * Kept as a server component so the session cookie is read on the server and
 * never becomes reachable from browser JavaScript. The root layout renders it as
 * a slot inside the client-side SiteHeader, which is how a server component can
 * be passed into a client component's children.
 *
 * If Supabase is not configured yet, getSessionProfile reports `unapproved` and
 * the button renders in its signed-out state - the public site still works.
 *
 * The permission list travels with the profile rather than being recomputed in the
 * browser, because the role column is no longer the whole answer: database roles
 * live in tables the anon key cannot read. Resolving here means one round trip
 * instead of one per tab, and it means the UI is showing what the server would
 * decide rather than an approximation of it.
 */
export async function AuthButton() {
  const result = await getSessionProfile();
  const profile: ProfileDTO | null = result.ok ? result.profile : null;
  const permissions = profile ? await getEffectivePermissions(profile) : [];

  return <AuthDialog profile={profile} permissions={permissions} />;
}
