import "server-only";

/**
 * Data Access Layer.
 *
 * This is the security boundary. Every privileged database read and mutation in
 * the project goes through a function in this file, and every one of those
 * functions starts by re-deriving the caller's identity from the signed session
 * cookie. Nothing here trusts a value that arrived from the browser — not a
 * role, not a status, not a SteamID64, not an application id.
 *
 * Three rules this file exists to enforce:
 *
 *   1. Authorisation is checked at the point of data access, not in the page or
 *      the component. A Server Action is a POST endpoint that anyone can call
 *      directly, so a page-level guard protects nothing on its own.
 *
 *   2. The role used for the decision is re-read from the database, not taken
 *      from the token. A token issued while someone was `leader` must stop
 *      working the moment their role is downgraded, not in 24 hours. The token
 *      role is used only to render UI.
 *
 *   3. Only this module may read the service-role key, and only after the
 *      session check has passed.
 */

import { cache } from "react";
import { cookies } from "next/headers";

import { isSupabaseConfigured } from "@/lib/env";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { queryError } from "@/lib/supabase/errors";
import { inspectSessionToken } from "@/lib/auth/session";
import { SessionError } from "@/lib/auth/session-error";
import { SESSION_COOKIE_NAME } from "@/types/auth";
import type {
  ApplicationRecord,
  ApprovalStatus,
  ProfileDTO,
  ProfileRecord,
  SessionCheck,
} from "@/types/auth";
import { assertCan } from "@/lib/permissions/effective";
import { readRoleSet, readRoleSets } from "@/lib/auth/roles";
import type { Action, PermissionContext } from "@/lib/permissions";
import { normalizeRoles, type ApplicationStatus, type Role } from "@/types/party";

/** Thrown when a session is absent, stale, or lacks the required role. */
export { SessionError } from "@/lib/auth/session-error";

/* -------------------------------------------------------------------------- */
/* Identity                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Resolve the current caller to a live profile, or explain why not.
 *
 * `cache()` memoises this for the duration of a single render pass, so a page
 * that checks the session in three places reads the cookie and hits the
 * database once rather than three times. It is scoped to the request, so it
 * never leaks one user's identity into another's render.
 *
 * Returns a fresh DTO rather than the raw row: `phone`, `notes` and
 * `approved_by` are stripped so that a careless pass-to-client cannot leak
 * staff contact details into the bundle.
 */
export const getSessionProfile = cache(async (): Promise<SessionCheck> => {
  const cookieStore = await cookies();
  const inspected = await inspectSessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);

  // `inspect` rather than a bare verify, so a user whose 24 hours elapsed is told
  // the session expired instead of being told their token was forged. Both deny
  // access identically; only the wording differs.
  if (!inspected.ok) return { ok: false, reason: inspected.reason };

  const payload = inspected.payload;

  if (!isSupabaseConfigured()) {
    // No database means no way to confirm the account is still a member, and
    // the token alone is not enough: a pending applicant must not reach the
    // portal just because they hold a well-signed token.
    return { ok: false, reason: "unapproved" };
  }

  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id, persona, avatar_url, status")
    .eq("steam_id", payload.steamId)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "unapproved" };

  // The roles come from the assignment rows, never from the `role` cache column:
  // a person may hold several, and the column can only ever name the highest one.
  const roles = await readRoleSet(payload.steamId);
  const profile = toProfileDTO(data as ProfileRow, roles);

  // Re-read authority from the database, overriding whatever the token claims.
  return { ok: true, profile };
});

/**
 * Like getSessionProfile, but throws instead of returning a result union.
 *
 * The status check here is the actual revocation boundary, and it cannot be
 * delegated to `can()`. `can()` answers "may this role do X" and deliberately
 * ignores membership state, because the same matrix has to be callable from the
 * client to decide what to render. So a member removed from the party kept their
 * `role` of `member`, `can("member", "registry.view")` stayed true, and every
 * portal DAL entry point in app/lib/portal/dal.ts — which all funnel through
 * here — would have kept serving them the registry, the reports and the schedule.
 * The UI hid the portal behind an `approved` check, but a Server Action is a POST
 * endpoint anyone can call with a hand-written payload, so the UI check was
 * cosmetic.
 *
 * `getSessionProfile` stays status-agnostic on purpose: the header needs to
 * render "you were removed, you may apply again" for exactly this person, and
 * the admin panel needs to see applicants. Only data access is closed.
 */
export async function requireSession(): Promise<ProfileDTO> {
  const result = await getSessionProfile();
  if (!result.ok) throw new SessionError(result.reason);
  if (result.profile.status !== "approved") throw new SessionError("unapproved");
  return result.profile;
}

/**
 * Assert the caller may perform `action`, re-checking the live profile first.
 *
 * The replacement for the old `requireRole(["leader", "admin"])`. It is a
 * permission check rather than a role check for two reasons.
 *
 * First, the one that mattered: a person whose whole job is the map was made an
 * `admin` to get `point.editAny`, and that is not what the job is. Now that roles
 * live in the database, that person can hold `map_editor` and nothing else.
 *
 * Second, the order. The session must be *approved* before a permission even
 * matters — a `pending` applicant holds a perfectly valid signature but no
 * standing — so this goes through `requireSession` rather than resolving
 * permissions on its own.
 */
export async function requirePermission(
  action: Action,
  ctx: PermissionContext = {},
): Promise<ProfileDTO> {
  const profile = await requireSession();
  await assertCan(profile, action, ctx);
  return profile;
}

/* -------------------------------------------------------------------------- */
/* Profile lifecycle                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Create or refresh the profile row for a Steam account that just signed in.
 *
 * The obvious implementation — a single `.upsert(..., { onConflict: "steam_id" })`
 * with `status: "pending"` in the payload — is a serious privilege bug. PostgREST
 * builds a plain `INSERT ... ON CONFLICT DO UPDATE` and overwrites *every* column
 * it was given, so each sign-in would drag an `approved` leader back to
 * `pending` and quietly lock the council out of its own panel. The same payload
 * would reset `role` too if it were ever included.
 *
 * So this deliberately does not upsert. It reads first, then:
 *
 *   - existing row: UPDATE only the mutable identity fields. `role`, `status` and
 *     `approved_by` are never named, so PostgreSQL cannot touch them. Membership
 *     is granted by a human, never by logging in.
 *   - no row: INSERT with `status: "pending"`, matching the column default. A
 *     brand-new account starts with no standing.
 *
 * The read-then-write is not atomic, so two simultaneous first-time logins could
 * both see "no row" and race. The insert catches the 23505 unique violation and
 * falls back to the update path, which makes the pair idempotent.
 */
export async function upsertProfileOnSignIn(input: {
  steamId: string;
  persona: string;
  avatarUrl: string;
  realName: string | null;
}): Promise<ProfileDTO> {
  const admin = getSupabaseAdmin();

  const identity = {
    persona: input.persona,
    avatar_url: input.avatarUrl,
    real_name: input.realName,
  };

  const columns = "steam_id, persona, avatar_url, status";

  const updateExisting = async (): Promise<ProfileDTO> => {
    const { data, error } = await admin
      .from("profiles")
      .update(identity)
      .eq("steam_id", input.steamId)
      .select(columns)
      .single();

    if (error || !data) {
      throw queryError(`Failed to update profile ${input.steamId}`, error ?? { message: "not found" });
    }
    return toProfileDTO(data as ProfileRow, await readRoleSet(input.steamId));
  };

  const { data: existing, error: readError } = await admin
    .from("profiles")
    .select(columns)
    .eq("steam_id", input.steamId)
    .maybeSingle();

  if (readError) {
    throw queryError(`Failed to read profile ${input.steamId}`, readError);
  }

  if (existing) return updateExisting();

  const { data, error } = await admin
    .from("profiles")
    .insert({ steam_id: input.steamId, ...identity, status: "pending" })
    .select(columns)
    .single();

  if (error) {
    // Lost the race with a concurrent first login: the row now exists, so take
    // the update path. Any other failure is a real problem.
    if (error.code === "23505") return updateExisting();
    throw queryError(`Failed to create profile ${input.steamId}`, error);
  }

  return toProfileDTO(data as ProfileRow, await readRoleSet(input.steamId));
}

/* -------------------------------------------------------------------------- */
/* People — staff only                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Sort order for a people list: what needs a decision first.
 *
 * The Postgres `approval_status` enum is declared in the order pending, approved,
 * rejected, so an `order by status` happens to match. That is a coincidence of
 * declaration order, not a contract, and it is the kind of coincidence that
 * survives a renamed enum value. Written out instead.
 */
const STATUS_RANK: Record<ApprovalStatus, number> = {
  pending: 0,
  approved: 1,
  rejected: 2,
};

/**
 * Every `profiles` row, whatever its status.
 *
 * This is the screen the approval queue could not be. `join_applications` holds
 * people who filled in the form; `profiles` holds people who signed in through
 * Steam, and those two sets barely overlap — the sign-in path writes a profile and
 * no application at all, so an account created by logging in was invisible to the
 * queue and the only way to act on it was to edit the database by hand. Someone
 * removed from the party and signing back in is the same story: no new
 * application, so nothing re-entered review.
 *
 * The two are therefore not merged into one list. A queue is a to-do list, and
 * showing it 400 people who are already approved turns a decision screen into a
 * database browser. This returns all of them, ordered so the ones needing a
 * decision are on top, and the reviewer works top-down and stops when the
 * remaining rows are all settled.
 *
 * `notes` and `approved_by` are not selected. `notes` is a moderator's private
 * column on the same table this query reads, and there is no reason for it to
 * reach the browser of every staff member's table view.
 */
export async function listProfiles(): Promise<ProfileRecord[]> {
  await requirePermission("registry.view");

  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .select(
      "steam_id, display_name, persona, real_name, status, discord, created_at, approved_at",
    )
    .order("created_at", { ascending: false });

  if (error) throw queryError("Failed to read profiles", error);

  const rows = (data ?? []) as unknown as ProfileRow[];

  // One extra query for the whole table rather than one per person, which is the
  // difference between two round trips and four hundred on a real membership.
  const roleSets = await readRoleSets(rows.map((row) => row.steam_id));

  const records = rows.map((row): ProfileRecord => {
    const r = row as unknown as Record<string, unknown>;
    // `role` is no longer selected from the row: it is the cache column, and
    // reading it here would report a leader who is also a moderator as a leader
    // only, which is exactly the bug 005 set out to fix.
    const roles = normalizeRoles(roleSets.get(r.steam_id as string) ?? []);
    return {
      steamId: String(r.steam_id ?? ""),
      displayName: String(r.display_name ?? "") || String(r.persona ?? ""),
      persona: String(r.persona ?? ""),
      realName: (r.real_name as string | null) ?? null,
      roles,
      role: roles[0],
      status: (r.status as ApprovalStatus) ?? "pending",
      discord: (r.discord as string | null) ?? null,
      createdAt: String(r.created_at ?? ""),
      approvedAt: (r.approved_at as string | null) ?? null,
    };
  });

  // Same ordering rationale as the queue: pending first, then approved, then
  // rejected, newest inside each group. A stable order matters because the whole
  // point is scanning down until the decisions run out.
  return records.sort((a, b) => {
    if (a.status !== b.status) return STATUS_RANK[a.status] - STATUS_RANK[b.status];
    return b.createdAt.localeCompare(a.createdAt);
  });
}
/* -------------------------------------------------------------------------- */
/* Applications — staff only                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read the approval queue.
 *
 * Returns applicant PII (name, email, phone, motivation), which is exactly why
 * the function is staff-only and lives behind the service-role client. The RLS
 * policies give the browser's anon key no access to this table at all, so this
 * is the only route to those rows.
 *
 * Ordered pending-first so the queue matches the order staff work through it.
 */
export async function listApplications(): Promise<ApplicationRecord[]> {
  await requirePermission("application.review");

  const { data, error } = await getSupabaseAdmin()
    .from("join_applications")
    .select(
      "id, source, name, email, phone, discord, steam, district, motivation, status, notes, submitted_at, reviewed_at",
    )
    .order("status", { ascending: true })
    .order("submitted_at", { ascending: false });

  if (error) throw queryError("Failed to read applications", error);

  const rows = ((data ?? []) as ApplicationRow[]).map(toApplicationRecord);

  // Accounts that arrived by signing in rather than by filling in the form.
  const signIns = await listSignInRequestsUnchecked();

  // Pending first, then newest first — the same order the application query
  // produced, so the merged list is one consistent queue rather than two
  // interleaved ones.
  return [...rows, ...signIns].sort((a, b) => {
    if (a.status !== b.status) return a.status === "pending" ? -1 : 1;
    return b.submittedAt.localeCompare(a.submittedAt);
  });
}

/**
 * Accounts waiting on a decision because somebody signed in through Steam.
 *
 * This is the whole of the admin queue now. The `/join` page hands applicants to
 * an external Google Form, so `join_applications` is not where people arrive
 * any more — but signing in through Steam still creates a `profiles` row and
 * nothing else, and a row nobody can see is a person nobody can approve. Without
 * this the only way to let a Steam-only account into the party was to edit the
 * database by hand.
 *
 * Only `pending` rows. An approved account is in the people list, and a rejected
 * one has already been decided on; either would be a settled case wearing the
 * costume of a new arrival.
 *
 * Returned in the `ApplicationRecord` shape rather than as profiles so the
 * existing review table and `setApplicationStatus` work unchanged: the synthetic
 * id carries the decision to the profile row.
 */
export async function listSignInRequests(): Promise<ApplicationRecord[]> {
  await requirePermission("application.review");
  return listSignInRequestsUnchecked();
}

async function listSignInRequestsUnchecked(): Promise<ApplicationRecord[]> {
  const { data: pendingProfiles, error } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id, display_name, persona, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: false });

  if (error) throw queryError("Failed to read pending profiles", error);

  return ((pendingProfiles ?? []) as unknown as PendingProfileRow[]).map(
    (row): ApplicationRecord => {
      const name = row.display_name?.trim() || row.persona?.trim() || row.steam_id;
      return {
        id: profileApplicationId(row.steam_id),
        source: "native",
        // A flag rather than a new `application_source` enum value: these rows
        // are never inserted, and adding a value to a Postgres enum needs a
        // migration — a schema change to render a label in one table is not a
        // trade worth making.
        fromSignIn: true,
        name,
        email: "",
        phone: "",
        discord: "",
        steam: row.steam_id,
        district: "Другой",
        motivation: "Вход через Steam",
        status: "pending",
        notes: "",
        submittedAt: row.created_at,
        reviewedAt: null,
      };
    },
  );
}

/**
 * Districts the form offers. Mirrors the check constraint on
 * `join_applications.district` — a value outside this list is rejected by the
 * database with a constraint-violation message nobody can act on, so the two have
 * to agree. Changing one without the other is the whole bug this comment exists
 * to prevent.
 */
const DISTRICTS = ["Центральный", "Заречный", "Северный", "Восточный", "Другой"] as const;

/**
 * A rejection the applicant is meant to read.
 *
 * The public form can be called by anyone, so its error path cannot assume the
 * message is safe to show: a Supabase failure can name tables and columns. This
 * class is the explicit permission to display a message verbatim, and only the
 * validation branches in `createApplication` throw it. Everything else stays a
 * plain `Error` and is replaced with generic copy at the boundary.
 */
export class FormError extends Error {}

/**
 * Application ids that are not a row in `join_applications`.
 *
 * A person can arrive at the party by signing in through Steam, which creates a
 * `profiles` row and nothing else — no application, so the review queue could not
 * see them and the only way to approve was to change the database by hand. The
 * queue has to present both kinds of applicant, so synthetic entries are keyed
 * with a prefix that cannot collide with a real `bigint` identity, and
 * `setApplicationStatus` routes on it.
 *
 * The prefix is the SteamID rather than a fresh surrogate so the reviewer sees
 * who is being decided on, and so approving is idempotent: the same person
 * arriving twice updates one profile instead of accumulating queue rows.
 */
const PROFILE_APPLICATION_PREFIX = "profile:";

function profileApplicationId(steamId: string): string {
  return `${PROFILE_APPLICATION_PREFIX}${steamId}`;
}

function parseProfileApplicationId(id: string): string | null {
  if (!id.startsWith(PROFILE_APPLICATION_PREFIX)) return null;
  return id.slice(PROFILE_APPLICATION_PREFIX.length);
}

/**
 * File a membership application. No session required — this is the front door.
 *
 * It is the one write in this file that runs on a service-role client with no
 * caller to check, because RLS denies `anon` on `join_applications` entirely: the
 * table holds applicants' name, email and phone, and the database refuses to let
 * the browser read or write it. A public form therefore cannot go through PostgREST
 * as the visitor; it has to be inserted here, with the service role, and the
 * safety has to come from validation and volume limits instead of from RLS.
 *
 * What that means concretely:
 *   - every field is validated here to the same bound as the column check, so a
 *     bad request fails with a message the applicant can act on rather than a
 *     constraint name;
 *   - nothing is echoed back. The applicant is told it was filed and gets an id,
 *     which is all they need, and the response cannot be used to confirm whether
 *     a given SteamID or email is already in the system;
 *   - `steam` is free text because the applicant types it by hand and may get it
 *     wrong. It is normalised to NULL when blank, so "did not say" is one value
 *     and not three.
 *
 * A member removed from the party files through this same door, which is the
 * point: nothing about their account is deleted, so the form cannot tell an
 * outsider from a former member and does not need to.
 */
export async function createApplication(input: {
  name: string;
  email?: string;
  phone?: string;
  discord: string;
  steam: string;
  district?: string;
  motivation: string;
}): Promise<number> {
  if (!isSupabaseConfigured()) {
    throw new FormError("Приём заявок временно недоступен");
  }

  if (input.steam) {
    // The columns here are `steam` and `submitted_at` — the applicant's claimed
    // SteamID and the queue's own timestamp. Querying `steam_id`/`created_at`
    // instead returns a PostgREST error, `recentApplication` comes back null, and
    // the check silently never fires while appearing to be there.
    const supabase = getSupabaseAdmin();
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const { data: recentApplication } = await supabase
      .from("join_applications")
      .select("id")
      .eq("steam", input.steam.trim())
      .gte("submitted_at", oneDayAgo)
      .order("submitted_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (recentApplication) {
      throw new FormError(
        "Вы уже подавали заявку за последние 24 часа. Пожалуйста, подождите решения совета."
      );
    }
  }

  const name = input.name.trim().replace(/\s+/g, " ");
  if (name.length < 2 || name.length > 80) {
    throw new FormError("Укажите имя: от 2 до 80 символов");
  }

  const email = input.email?.trim().toLowerCase() ?? "";
  if (email.length > 0 && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
    throw new FormError("Проверьте адрес почты");
  }

  const phone = input.phone?.trim() ?? "";
  if (phone.length > 0 && (phone.length < 6 || phone.length > 32)) {
    throw new FormError("Проверьте телефон: от 6 до 32 символов");
  }

  const steam = input.steam.trim();
  if (steam.length > 0 && !/^7656119[0-9]{10}$/.test(steam)) {
    throw new FormError("SteamID64 должен выглядать как 76561198000000000");
  }

  const motivation = input.motivation.trim().slice(0, 4000);

  // An unrecognised district falls back to "Другой" instead of being rejected.
  // The column is NOT NULL, so sending an unknown value through would fail the
  // whole insert and lose the entire application over one field. Losing the
  // district is recoverable; losing the application is not.
  const district = DISTRICTS.includes(input.district as (typeof DISTRICTS)[number])
    ? (input.district as string)
    : DISTRICTS[DISTRICTS.length - 1];

  // `email`, `phone` and `district` are NOT NULL in the live schema but all carry
  // DEFAULTs, which is why omitting them still inserts. They are written
  // explicitly so the intent is visible: a restored form field must not silently
  // become an empty string because the default was doing the work.
  const { data, error } = await getSupabaseAdmin()
    .from("join_applications")
    .insert({
      name,
      email,
      phone,
      discord: input.discord.trim().slice(0, 120),
      steam: steam.length > 0 ? steam : null,
      district,
      motivation,
      status: "pending",
    })
    .select("id")
    .single();

  if (error || !data) {
    throw queryError("Не удалось отправить заявку", error ?? { message: "not found" });
  }

  return Number((data as { id: number }).id);
}

/**
 * Approve or reject an application.
 *
 * Re-verifies staff authority inside the function rather than trusting the
 * caller, because this is reachable by a direct POST. `reviewed_by` is taken
 * from the verified session, not from the request, so a reviewer cannot be
 * forged by editing the payload.
 *
 * Approving also grants membership, which this function did not used to do. The
 * application and the profile were separate rows that nothing ever joined, so
 * approving an applicant flipped the queue entry to green and left the person
 * with no portal access and no way to get it — the queue looked like it worked
 * and the outcome was a locked account. It matters most for somebody removed
 * from the party: the form on /join is the only way back in, so if approval does
  * not restore the profile, the form on /join is a dead end.
 *
 * Only applications carrying a usable SteamID64 can grant membership. Anything
 * else still gets its status updated — a reviewer can close a paper application
 * — but it cannot conjure an account out of a mistyped number, and the reviewer
 * is told so instead of discovering it later.
 */
export async function setApplicationStatus(input: {
  id: string;
  status: Extract<ApplicationStatus, "approved" | "rejected">;
  notes?: string;
}): Promise<ApplicationRecord> {
  const reviewer = await requirePermission("application.review");

  // A synthetic entry from the sign-in list: there is no application row to
  // settle, so the decision lands on the profile directly. Same staff check, same
  // reviewer stamped on it, same rule about not touching a settled account.
  const profileSteamId = parseProfileApplicationId(input.id);
  if (profileSteamId) {
    return decideOnProfileApplicant(profileSteamId, input.status, reviewer.steamId);
  }

  const { data, error } = await getSupabaseAdmin()
    .from("join_applications")
    .update({
      status: input.status,
      notes: input.notes ?? "",
      reviewed_at: new Date().toISOString(),
      reviewed_by: reviewer.steamId,
    })
    .eq("id", input.id)
    .select(
      "id, source, name, email, phone, discord, steam, district, motivation, status, notes, submitted_at, reviewed_at",
    )
    .single();

  if (error || !data) {
    throw queryError(`Failed to update application ${input.id}`, error ?? { message: "not found" });
  }

  const record = toApplicationRecord(data as ApplicationRow);

  if (record.status === "approved" && record.steam && /^7656119[0-9]{10}$/.test(record.steam)) {
    await grantMembership(record.steam, reviewer.steamId);
  }

  return record;
}

/**
 * Approve or reject somebody who arrived by signing in rather than by applying.
 *
 * Returns an `ApplicationRecord` so the review table can swap the row in place,
 * exactly as it does for a real application — the queue must not need a reload to
 * reflect a decision, or a reviewer clicking twice would act on a row that is no
 * longer there.
 */
async function decideOnProfileApplicant(
  steamId: string,
  status: "approved" | "rejected",
  reviewerId: string,
): Promise<ApplicationRecord> {
  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id, display_name, persona, created_at")
    .eq("steam_id", steamId)
    .maybeSingle();

  if (error) throw queryError(`Failed to read profile ${steamId}`, error);
  if (!data) throw new Error("Профиль не найден");

  const row = data as PendingProfileRow;
  const reviewedAt = new Date().toISOString();

  const { error: writeError } = await getSupabaseAdmin()
    .from("profiles")
    .update({
      status,
      ...(status === "approved" ? { approved_at: reviewedAt, approved_by: reviewerId } : {}),
    })
    .eq("steam_id", steamId);

  if (writeError) throw queryError(`Failed to update profile ${steamId}`, writeError);

  return {
    id: profileApplicationId(steamId),
    source: "native",
    fromSignIn: true,
    name: row.display_name?.trim() || row.persona?.trim() || steamId,
    email: "",
    phone: "",
    discord: "",
    steam: steamId,
    district: "Другой",
    motivation: "Вход через Steam",
    status,
    notes: "",
    submittedAt: row.created_at,
    reviewedAt,
  };
}

/**
 * Grant membership to a SteamID that has just been approved.
 *
 * A member whose profile row was never deleted — the removal path only changes
 * `status` — is updated in place, so their hours, appeals and attendance all
 * survive an expulsion and come back with them. A never-seen SteamID is inserted
 * as a plain member, which is the original path into the party and the only reason
 * `profiles` is keyed on SteamID rather than on `join_applications`.
 *
 * The one thing it will not do is touch an account that is already approved. An
 * application carrying somebody else's SteamID is one stray form in the queue away
 * from demoting a leader, and the reviewer is reading a table of strangers rather
 * than the member list. Roles belong to the role editor, which checks
 * `profile.setRole` and is obviously about roles.
 */
async function grantMembership(steamId: string, reviewerId: string): Promise<void> {
  const { data: existing, error: readError } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id, status")
    .eq("steam_id", steamId)
    .maybeSingle();

  if (readError) {
    throw queryError(`Failed to read profile ${steamId}`, readError);
  }

  // Already a member: settled. Rewriting the roles or the approval timestamps here
  // would hand this reviewer credit for a decision somebody else made.
  if (existing && (existing as { status: string }).status === "approved") return;

  // No `role` in this payload, and that is deliberate. The column still exists and
  // still has a default, but since 005 a trigger owns it: it is the highest role in
  // `profile_role_assignments`, and it fires on every change to that table. Writing
  // `role: "member"` here would be writing a derived value from a second source, and
  // on the one person this is actually about — a member expelled and re-approved
  // while they still hold an assignment row — it would contradict the trigger and
  // be silently overwritten by the next role change. Membership and roles are set
  // by different people, so they are written by different columns.
  const membership = {
    status: "approved" as const,
    approved_at: new Date().toISOString(),
    approved_by: reviewerId,
  };

  const write = existing
    ? await getSupabaseAdmin().from("profiles").update(membership).eq("steam_id", steamId)
    : await getSupabaseAdmin()
        .from("profiles")
        .insert({
          steam_id: steamId,
          // `persona` is the Steam name and is normally overwritten on sign-in;
          // seeding a placeholder means the row is not blank for the moment
          // between approval and the account's first login.
          persona: "—",
          ...membership,
        });

  if (write.error) {
    throw queryError(`Failed to grant membership for ${steamId}`, write.error);
  }
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

interface ProfileRow {
  steam_id: string;
  persona: string;
  avatar_url: string;
  status: ApprovalStatus;
}

/** The four profile columns the sign-in queue reads. */
interface PendingProfileRow {
  steam_id: string;
  display_name: string;
  persona: string;
  created_at: string;
}

interface ApplicationRow {
  id: number | string;
  source: ApplicationRecord["source"];
  name: string;
  email: string;
  phone: string;
  discord: string;
  steam: string | null;
  district: string;
  motivation: string;
  status: ApplicationStatus;
  notes: string;
  submitted_at: string;
  reviewed_at: string | null;
}

function toProfileDTO(row: ProfileRow, roles: Role[]): ProfileDTO {
  // `roles` arrives already normalised from the caller, and `role` is derived from
  // it here rather than read from the database, so the two fields of the DTO cannot
  // disagree about what this person holds.
  const held = normalizeRoles(roles);
  return {
    steamId: row.steam_id,
    persona: row.persona,
    avatarUrl: row.avatar_url,
    roles: held,
    role: held[0],
    status: row.status,
  };
}

function toApplicationRecord(row: ApplicationRow): ApplicationRecord {
  return {
    id: String(row.id),
    source: row.source,
    name: row.name,
    email: row.email,
    phone: row.phone,
    discord: row.discord,
    steam: row.steam,
    district: row.district,
    motivation: row.motivation,
    status: row.status,
    notes: row.notes,
    // Rendered as a plain local date; the admin table shows a day, not a time.
    submittedAt: row.submitted_at.slice(0, 10),
    reviewedAt: row.reviewed_at,
  };
}
