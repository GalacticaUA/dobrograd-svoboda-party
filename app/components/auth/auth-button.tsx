import { AuthDialog } from "@/components/auth/auth-dialog";
import { getSessionProfile } from "@/lib/auth/dal";
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
 */
export async function AuthButton() {
  const result = await getSessionProfile();
  const profile: ProfileDTO | null = result.ok ? result.profile : null;

  return <AuthDialog profile={profile} />;
}
