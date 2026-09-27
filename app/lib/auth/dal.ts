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
import { SESSION_COOKIE_NAME } from "@/types/auth";
import type {
  ApplicationRecord,
  ApprovalStatus,
  ProfileDTO,
  SessionCheck,
  SessionFailure,
} from "@/types/auth";
import type { ApplicationStatus, Role } from "@/types/party";

/** Thrown when a session is absent, stale, or lacks the required role. */
export class SessionError extends Error {
  readonly reason: SessionFailure;

  constructor(reason: SessionFailure) {
    super(`Session rejected: ${reason}`);
    this.name = "SessionError";
    this.reason = reason;
  }
}

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
    .select("steam_id, persona, avatar_url, role, status")
    .eq("steam_id", payload.steamId)
    .maybeSingle();

  if (error || !data) return { ok: false, reason: "unapproved" };

  const profile = toProfileDTO(data as ProfileRow);

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
 * Assert the caller holds one of `allowed`, re-checking the live profile.
 *
 * Note the order: the session must be *approved* before a role even matters. A
 * `pending` applicant holds a perfectly valid signature but no standing.
 */
export async function requireRole(allowed: readonly Role[]): Promise<ProfileDTO> {
  // `requireSession` already rejects anything that is not `approved`, so by the
  // time a role is worth checking the caller is a member of the party.
  const profile = await requireSession();

  if (!allowed.includes(profile.role)) {
    throw new SessionError("forbidden");
  }

  return profile;
}

/** Convenience wrapper for the two roles that may use the admin portal. */
export function requireStaff(): Promise<ProfileDTO> {
  return requireRole(["leader", "admin"]);
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

  const columns = "steam_id, persona, avatar_url, role, status";

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
    return toProfileDTO(data as ProfileRow);
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

  return toProfileDTO(data as ProfileRow);
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
  await requireStaff();

  const { data, error } = await getSupabaseAdmin()
    .from("join_applications")
    .select(
      "id, source, name, email, phone, discord, steam, district, motivation, status, notes, submitted_at, reviewed_at",
    )
    .order("status", { ascending: true })
    .order("submitted_at", { ascending: false });

  if (error) throw queryError(`Failed to read applications`, error);

  return ((data ?? []) as ApplicationRow[]).map(toApplicationRecord);
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
  // email: string;
  // phone: string;
  discord: string;
  steam: string;
  // district: string;
  motivation: string;
}): Promise<number> {

  if (!isSupabaseConfigured()) {
    throw new FormError("Приём заявок временно недоступен");
  }

  if (input.steam) {
  const supabase = getSupabaseAdmin();
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const { data: recentApplication } = await supabase
    .from("join_applications")
    .select("created_at")
    .eq("steam_id", input.steam)
    .gte("created_at", oneDayAgo)
    .order("created_at", { ascending: false })
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

  // const email = input.email.trim().toLowerCase();
  // if (email.length > 0 && (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) {
  //   throw new FormError("Проверьте адрес почты");
  // }

  // const phone = input.phone.trim();
  // if (phone.length > 0 && (phone.length < 6 || phone.length > 32)) {
  //   throw new FormError("Проверьте телефон: от 6 до 32 символов");
  // }

  const steam = input.steam.trim();
  if (steam.length > 0 && !/^7656119[0-9]{10}$/.test(steam)) {
    throw new FormError("SteamID64 должен выглядеть как 76561198000000000");
  }

  // const district = DISTRICTS.includes(input.district as (typeof DISTRICTS)[number])
  //   ? input.district
  //   : "Другой";

  const motivation = input.motivation.trim().slice(0, 4000);

  const { data, error } = await getSupabaseAdmin()
    .from("join_applications")
    .insert({
      name,
      // email,
      // phone,
      discord: input.discord.trim().slice(0, 120),
      steam: steam.length > 0 ? steam : null,
      // district,
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
 * not restore the profile, "выгнать, потом подать заявку заново" is a dead end.
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
  const reviewer = await requireStaff();

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
    // A member whose profile row was never deleted — the removal path only
    // changes `status` — is updated in place, so their hours, appeals and
    // attendance all survive a removal and return with them. A never-seen
    // SteamID is inserted as a plain member, which is the original path into the
    // party and the only reason `profiles` is keyed on SteamID rather than on
    // `join_applications`.
    const { data: existing, error: readError } = await getSupabaseAdmin()
      .from("profiles")
      .select("steam_id")
      .eq("steam_id", record.steam)
      .maybeSingle();

    if (readError) {
      throw queryError(`Failed to read profile ${record.steam}`, readError);
    }

    const membership = {
      status: "approved" as const,
      role: "member" as const,
      approved_at: new Date().toISOString(),
      approved_by: reviewer.steamId,
    };

    const write = existing
      ? await getSupabaseAdmin().from("profiles").update(membership).eq("steam_id", record.steam)
      : await getSupabaseAdmin()
          .from("profiles")
          .insert({
            steam_id: record.steam,
            // `persona` is the Steam name and is normally overwritten on first
            // sign-in; seeding it with the name from the form is only a
            // placeholder so the row is not blank before they ever log in.
            persona: record.name,
            display_name: record.name,
            ...membership,
          });

    if (write.error) {
      throw queryError(`Failed to grant membership for ${record.steam}`, write.error);
    }
  }

  return record;
}

/* -------------------------------------------------------------------------- */
/* Row mapping                                                                 */
/* -------------------------------------------------------------------------- */

interface ProfileRow {
  steam_id: string;
  persona: string;
  avatar_url: string;
  role: Role;
  status: ApprovalStatus;
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

function toProfileDTO(row: ProfileRow): ProfileDTO {
  return {
    steamId: row.steam_id,
    persona: row.persona,
    avatarUrl: row.avatar_url,
    role: row.role,
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
