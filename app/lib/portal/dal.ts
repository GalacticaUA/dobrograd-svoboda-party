import "server-only";

/**
 * Portal Data Access Layer.
 *
 * The same contract as app/lib/auth/dal.ts, and the rules there apply unchanged:
 *
 *   1. Every function re-derives the caller from the signed session cookie. A
 *      Server Action is a POST endpoint anybody can call with a hand-written
 *      payload, so authorisation must live here, not in the component.
 *
 *   2. The role comes from the live `profiles` row, never from the token, so a
 *      demotion takes effect immediately instead of in 24 hours.
 *
 *   3. Nothing arriving from the browser is trusted: not an id, not a role, not a
 *      status, not an author. Where a rule depends on ownership, the row is read
 *      back and compared against the verified SteamID64.
 *
 * Authorisation itself lives in app/lib/permissions.ts, which is client-safe and
 * shared with the UI. This file calls the same `can()` so the two can never
 * disagree about who is allowed to do what.
 */

import { requirePermission, requireSession } from "@/lib/auth/dal";
import { SessionError } from "@/lib/auth/session-error";
import { EVENT_DESCRIPTION_MAX, EVENT_TITLE_MAX } from "@/lib/portal/event-state";
import { getSupabaseAdmin } from "@/lib/supabase/server";
import { queryError, isMissingObject } from "@/lib/supabase/errors";
import {
  isAppealOpen,
  isPollOpen,
  applyChange,
  canChangeRoles,
  isAppointer,
  type Action,
} from "@/lib/permissions";
import { assertCan, canAct, canGrantAll, isGrantable } from "@/lib/permissions/effective";
import { countTopStanding, readRoleSet, readRoleSets } from "@/lib/auth/roles";
import { eventState } from "@/lib/portal/event-state";
import {
  APPEAL_STATUS_LABELS,
  displayNameOf,
  type AccountProfile,
  type AccountUpdateInput,
  type AppealRecord,
  type AppealStatus,
  type AttendanceInput,
  type AttendanceRecord,
  type AuditEntry,
  type AvailabilityMatrixRow,
  type AvailabilitySlot,
  type CustomRoleRecord,
  type DeclineRecord,
  type EventState,
  type EventStatus,
  type EventRecord,
  type EventUpsertInput,
  type EventWithAttendance,
  type HoursAdjustmentRecord,
  type MyHours,
  type PollOption,
  type PollRecord,
  type PublicEvent,
  type RegistryEntry,
  type RoleGrantRecord,
  type RoleGrantResult,
  type RsvpInput,
  type WorkPointInput,
  type WorkPointRecord,
} from "@/lib/portal/types";
import type { ApprovalStatus, ProfileDTO } from "@/types/auth";
import { isAppointment, normalizeRoles, type Role } from "@/types/party";

/* -------------------------------------------------------------------------- */
/* Audit                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Append to the audit log.
 *
 * Called after the mutation it describes, not before, so the log never claims
 * something that did not happen. A failure here is thrown rather than swallowed:
 * every mutation in this file is an idempotent upsert, so a visible error and a
 * retry produce the correct end state, whereas a silently dropped audit row
 * would leave hours or role changes untraceable.
 */
async function writeAudit(input: {
  actor: string | null;
  action: string;
  entity: string;
  entityId?: string | number | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  const { error } = await getSupabaseAdmin().from("audit_log").insert({
    actor: input.actor,
    action: input.action,
    entity: input.entity,
    entity_id: input.entityId == null ? null : String(input.entityId),
    meta: input.meta ?? {},
  });

  if (error) throw queryError(`Failed to write audit log`, error);
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                               */
/* -------------------------------------------------------------------------- */

interface MemberNameRow {
  steam_id: string;
  display_name: string;
  persona: string;
}

/**
 * Resolve a set of SteamIDs to display names in one query.
 *
 * This exists instead of a PostgREST embedded-resource select
 * (`select("*, profiles!appeals_author_fkey(...)")`) because the embedded syntax
 * depends on auto-generated constraint names. Those are `appeals_author_fkey`
 * today, but renaming a constraint would silently break every list at runtime
 * rather than at build time. One extra round trip is cheaper than that class of
 * bug, and the same map serves appeals, polls, attendance and the registry.
 */
async function loadMemberNames(
  steamIds: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  const unique = [...new Set(steamIds.filter((id): id is string => typeof id === "string"))];
  if (unique.length === 0) return new Map();

  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id, display_name, persona")
    .in("steam_id", unique);

  if (error) throw queryError(`Failed to resolve member names`, error);

  return new Map(
    ((data ?? []) as MemberNameRow[]).map((row) => [
      row.steam_id,
      displayNameOf({ displayName: row.display_name, persona: row.persona }),
    ]),
  );
}

/** PostgREST may hand back `numeric` as a string depending on the column. */
function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/* -------------------------------------------------------------------------- */
/* Account                                                                      */
/* -------------------------------------------------------------------------- */

// `role` is deliberately absent. It is the cache column and can only name the
// highest-standing role, so selecting it would report an admin who is also a
// moderator as an admin alone. The roles come from the assignment rows instead.
const ACCOUNT_COLUMNS =
  "steam_id, persona, avatar_url, status, display_name, about, telegram, " +
  "contacts_public, real_name, discord, phone, created_at, approved_at";

export async function getAccountProfile(): Promise<AccountProfile> {
  const session = await requireSession();
  return readAccountProfile(session.steamId);
}

async function readAccountProfile(steamId: string): Promise<AccountProfile> {
  const { data, error } = await getSupabaseAdmin()
    .from("profiles")
    .select(ACCOUNT_COLUMNS)
    .eq("steam_id", steamId)
    .maybeSingle();

  if (error || !data) {
    throw queryError(`Failed to read account ${steamId}`, error ?? { message: "not found" });
  }

  const row = data as unknown as Record<string, unknown>;
  const roles = await readRoleSet(steamId);

  return {
    steamId,
    persona: String(row.persona ?? ""),
    avatarUrl: String(row.avatar_url ?? ""),
    roles,
    role: roles[0],
    status: row.status as AccountProfile["status"],
    displayName: String(row.display_name ?? ""),
    about: String(row.about ?? ""),
    telegram: (row.telegram as string | null) ?? null,
    contactsPublic: row.contacts_public === true,
    realName: (row.real_name as string | null) ?? null,
    discord: (row.discord as string | null) ?? null,
    phone: (row.phone as string | null) ?? null,
    createdAt: String(row.created_at ?? ""),
    approvedAt: (row.approved_at as string | null) ?? null,
  };
}

/**
 * Update the caller's own account settings.
 *
 * `steam_id` is taken from the verified session and used as the filter, so there
 * is no parameter a caller could tamper with to edit somebody else's profile.
 * `role` and `status` are never named in the payload for the same reason
 * `upsertProfileOnSignIn` avoids them: PostgREST would happily write them.
 */
export async function updateAccountProfile(input: AccountUpdateInput): Promise<AccountProfile> {
  const session = await requireSession();
  await assertCan(session, "profile.editOwn");

  const displayName = input.displayName.trim().slice(0, 60);

  // A leading "@" is stripped rather than demanded. Requiring it was friction
  // with no payoff: Discord has since moved to plain usernames, and rejecting
  // "user" while accepting "@user" only teaches people the field is picky. What
  // is stored is always the bare handle, so nobody ends up with "@@name" after
  // typing a name that already carried one.
  const discord = input.discord.trim().replace(/^@+/, "").slice(0, 120);

  const { error } = await getSupabaseAdmin()
    .from("profiles")
    .update({
      display_name: displayName,
      about: input.about.trim().slice(0, 1000),
      discord: discord.length > 0 ? discord : null,
      contacts_public: input.contactsPublic,
    })
    .eq("steam_id", session.steamId);

  if (error) throw queryError(`Failed to update account`, error);

  await writeAudit({
    actor: session.steamId,
    action: "account.update",
    entity: "profiles",
    entityId: session.steamId,
  });

  return readAccountProfile(session.steamId);
}

/** Read any member's settings. Staff may; members may only read their own. */
export async function getMemberProfile(steamId: string): Promise<AccountProfile> {
  const session = await requireSession();
  const own = session.steamId === steamId;
  if (!own) await assertCan(session, "profile.editAny");
  return readAccountProfile(steamId);
}

/**
 * Replace a member's whole role set. Leader or admin only.
 *
 * The rules are not the permission matrix's to decide, so they live in
 * `canChangeRoles` and are called from here: this function supplies the
 * authoritative counts and enforces the answer. The badges in the UI ask the same
 * function, so the two cannot offer different futures.
 *
 * `roles` is the complete set, not a delta. A set is what the database can be asked
 * to enforce — "make this person exactly a moderator" is checkable, whereas
 * "add a moderator, then maybe add a leader, and roll back if the second fails" is
 * two decisions that can disagree — and it is what the client already has in hand,
 * having just rendered the row it is about to change.
 *
 * `[]` is a real value, not an omission: it means "appointments none", the member
 * keeps their membership and loses every title.
 *
 * The write goes through `set_profile_roles` rather than a direct insert, and that
 * is the point of the RPC: moving the title has to be atomic. Two clicks on two
 * people would otherwise be two independent writes, and there is a moment between
 * them where the database holds two leaders — exactly what the unique index exists
 * to forbid, and exactly what a client-side check cannot see.
 *
 * Approval is not part of this. It is a column with its own reasons, it is edited
 * from a different control, and it was a source of a real bug: sending it here
 * meant a status change repeated whatever role list the client happened to be
 * holding. `setMemberApproval` is the only way to move it.
 */
export async function setMemberRoles(input: {
  steamId: string;
  roles: readonly Role[];
}): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.setRole");

  // Existence only. What is being changed is in `profile_role_assignments`, and the
  // row's status is nobody's business in this function — asking for a column and
  // not using it is how a role edit ends up reporting a status it did not touch.
  const { data: target, error: targetError } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id")
    .eq("steam_id", input.steamId)
    .maybeSingle();

  if (targetError) throw queryError("Не удалось прочитать участника", targetError);
  if (!target) throw new Error("Участник не найден");

  const targetRoles = await readRoleSet(input.steamId);

  // Same count, same question, one number. `countTopStanding` counts people rather
  // than rows, so somebody who is both leader and admin is one appointable person
  // and not two.
  const verdict = canChangeRoles({
    actorRoles: actor.roles,
    targetRoles,
    change: { kind: "set", roles: input.roles },
    counts: { topStandingCount: await countTopStanding() },
  });

  if (!verdict.ok) throw new Error(verdict.reason);

  const { data: before } = await getSupabaseAdmin()
    .from("profile_role_assignments")
    .select("role")
    .eq("steam_id", input.steamId);

  const { error } = await getSupabaseAdmin().rpc("set_profile_roles", {
    p_steam_id: input.steamId,
    // Appointment roles only. `normalizeRoles` is the right thing to ask for the
    // caller's intent — "no roles" is `["member"]` — but `member` is not a row in
    // `profile_role_assignments` and the RPC deletes-then-inserts what it is given.
    // Passing it would either fail on the enum's intent or, worse, leave a
    // `member` row that the trigger would then have to special-case. `[]` is the
    // "appointments none" case the function above already documents.
    p_roles: normalizeRoles(input.roles).filter(isAppointment) as unknown as string[],
    p_actor: actor.steamId,
  });

  if (error) throw queryError("Не удалось изменить роли", error);

  await writeAudit({
    actor: actor.steamId,
    action: "profile.setRole",
    entity: "profiles",
    entityId: input.steamId,
    meta: {
      // Both sets, not "from" and "to". The audit reader's question after 005 is
      // "what changed", and for somebody who went from admin+moderator to moderator
      // a from/to pair of single roles would say only half of it.
      //
      // No status here, because this call did not touch it. A role change that also
      // reported a status would be claiming a second edit it did not make, and the
      // status moves through `setMemberApproval`, which writes its own audit row.
      from: normalizeRoles(
        ((before ?? []) as unknown as { role: Role }[]).map((row) => row.role),
      ),
      to: normalizeRoles(input.roles),
    },
  });
}

/**
 * Approve, suspend or expel somebody without touching their roles.
 *
 * A separate function from `setMemberRoles` because the two are edited in
 * different places and for different reasons: roles are a hat, status is
 * membership. Passing a client's idea of somebody's roles along with a status
 * change would also mean a stale role list could quietly overwrite a promotion
 * that happened in another tab, and nothing about "approve this applicant" wants
 * that risk.
 */
export async function setMemberApproval(
  steamId: string,
  status: AccountProfile["status"],
): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.setRole");

  const { data: target, error: readError } = await getSupabaseAdmin()
    .from("profiles")
    .select("status")
    .eq("steam_id", steamId)
    .maybeSingle();

  if (readError) throw queryError("Не удалось прочитать участника", readError);
  if (!target) throw new Error("Участник не найден");

  const { error } = await getSupabaseAdmin()
    .from("profiles")
    .update({
      status,
      approved_at: status === "approved" ? new Date().toISOString() : null,
    })
    .eq("steam_id", steamId);

  if (error) throw queryError("Не удалось изменить статус", error);

  await writeAudit({
    actor: actor.steamId,
    action: "profile.setRole",
    entity: "profiles",
    entityId: steamId,
    meta: { from: { status: (target as { status: string }).status }, to: { status } },
  });
}

/** Add one role to a member. The `+ Добавить роль` button. */export async function addMemberRole(steamId: string, role: Role): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.setRole");

  const targetRoles = await readRoleSet(steamId);
  if (targetRoles.length === 0) throw new Error("Участник не найден");

  const verdict = canChangeRoles({
    actorRoles: actor.roles,
    targetRoles,
    change: { kind: "add", role },
    counts: { topStandingCount: await countTopStanding() },
  });

  if (!verdict.ok) throw new Error(verdict.reason);

  const { error } = await getSupabaseAdmin().rpc("add_profile_role", {
    p_steam_id: steamId,
    p_role: role,
    p_actor: actor.steamId,
  });

  if (error) throw queryError("Не удалось назначить роль", error);

  await writeAudit({
    actor: actor.steamId,
    action: "profile.setRole",
    entity: "profile_role_assignments",
    entityId: steamId,
    meta: { from: targetRoles, to: applyChange(targetRoles, { kind: "add", role }) },
  });
}

/** Take one role away from a member. The `×` on a badge. */
export async function removeMemberRole(steamId: string, role: Role): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.setRole");

  const targetRoles = await readRoleSet(steamId);
  if (targetRoles.length === 0) throw new Error("Участник не найден");

  const verdict = canChangeRoles({
    actorRoles: actor.roles,
    targetRoles,
    change: { kind: "remove", role },
    counts: { topStandingCount: await countTopStanding() },
  });

  if (!verdict.ok) throw new Error(verdict.reason);

  const { error } = await getSupabaseAdmin().rpc("remove_profile_role", {
    p_steam_id: steamId,
    p_role: role,
    p_actor: actor.steamId,
  });

  if (error) throw queryError("Не удалось снять роль", error);

  await writeAudit({
    actor: actor.steamId,
    action: "profile.setRole",
    entity: "profile_role_assignments",
    entityId: steamId,
    meta: { from: targetRoles, to: applyChange(targetRoles, { kind: "remove", role }) },
  });
}

/**
 * Edit somebody else's public profile. Staff only (`profile.editAny`).
 *
 * Deliberately narrower than `updateAccountProfile`: an admin fixing a typo in
 * somebody's character name may correct the *naming* fields, but `role`,
 * `status`, `approved_at` and every contact field stay out of reach here. Role
 * changes go through `setMemberRoles` (leader or admin) and contacts are the
 * member's own business. An endpoint that could write `role` and was merely
 * mounted behind a staff check would quietly become a second, weaker way to
 * appoint leaders, and there would be no way to tell the two apart later in the
 * audit log.
 */
export async function updateMemberProfile(input: {
  steamId: string;
  displayName: string;
  about: string;
}): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.editAny");

  const displayName = input.displayName.trim().slice(0, 60);
  if (displayName.length === 0) throw new Error("Имя не может быть пустым");

  const { data: target } = await getSupabaseAdmin()
    .from("profiles")
    .select("display_name, about")
    .eq("steam_id", input.steamId)
    .maybeSingle();

  if (!target) throw new Error("Участник не найден");

  const { error } = await getSupabaseAdmin()
    .from("profiles")
    .update({ display_name: displayName, about: input.about.trim().slice(0, 1000) })
    .eq("steam_id", input.steamId);

  if (error) throw queryError(`Не удалось изменить профиль участника`, error);

  await writeAudit({
    actor: actor.steamId,
    action: "profile.editAny",
    entity: "profiles",
    entityId: input.steamId,
    meta: {
      from: { displayName: (target as { display_name: string }).display_name },
      to: { displayName },
    },
  });
}

/**
 * Remove a member from the party. Admin or leader (`profile.remove`).
 *
 * This is a status change, not a `delete from profiles`. The row has to survive
 * because it is the target of a cascade of foreign keys — attendance, hours,
 * appeals, availability, and every audit row they authored all point at
 * `profiles.steam_id`. Deleting it would rewrite the party's history and could
 * delete the audit trail of whoever expelled them. Instead:
 *
 *   - `status` -> 'rejected', which is the state `requireSession()` refuses, so
 *     every portal read and write fails for them from their next request on;
 *   - every row in `profile_role_assignments` deleted, so a removed admin cannot
 *     keep an outranking role. This goes through the RPC rather than a direct
 *     delete so the trigger refreshes the cache column in the same transaction —
 *     the column is derived, and a hand-written delete that forgot it would leave
 *     `profiles.role` claiming a leadership nobody has;
 *   - `approved_at` -> null, so the removal is visible in the profile itself and
 *     re-approval cannot silently reuse a stale timestamp.
 *
 * They keep their Steam account and their row, which is what makes the removal
 * reversible by design: `upsertProfileOnSignIn` never writes `status`, so
 * signing in again leaves them removed rather than resurrecting them, and they
 * may file a fresh application through /join instead.
 *
 * Three guards, because all three mistakes are unrecoverable through the UI:
 *   - a staff member cannot expel themselves, which would strand the account;
 *   - an admin cannot be expelled at all, since that would strip the role the
 *     interface is not allowed to touch;
 *   - the last person who can appoint cannot be expelled, which would leave
 *     nobody able to appoint a leader again — the portal's own recovery path
 *     would be gone.
 */
export async function removeMember(input: { steamId: string; reason: string }): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.remove");

  if (input.steamId === actor.steamId) {
    throw new Error("Нельзя исключить самого себя");
  }

  const { data: target } = await getSupabaseAdmin()
    .from("profiles")
    .select("status, display_name, persona")
    .eq("steam_id", input.steamId)
    .maybeSingle();

  if (!target) throw new Error("Участник не найден");

  const targetRow = target as { status: string; display_name: string; persona: string };
  const targetRoles = await readRoleSet(input.steamId);

  if (targetRow.status !== "approved") {
    // Distinguish the two non-approved states rather than lumping them together:
    // an expelled member is already out, and telling them they are "not in the
    // party" while they click "Исключить" is circular. A pending applicant is not
    // a member yet, so expelling them is really closing an application, which the
    // status dropdown already does.
    throw new Error(
      targetRow.status === "rejected"
        ? "Участник уже исключён из партии"
        : "Участник ещё не одобрен. Снять заявку с рассмотрения можно через «Изменить роль»",
    );
  }

  if (targetRoles.includes("admin")) {
    // Expelling somebody is the same act as demoting them, because the roles are
    // cleared below. Without this check, the rule that the admin role is not
    // touched through the interface would be bypassed by the one button that
    // looks like it only changes membership status.
    throw new Error("Роль админа меняется только напрямую в базе данных");
  }

  if (targetRoles.some(isAppointer) && (await countTopStanding()) <= 1) {
    throw new Error("Нельзя исключить последнего лидера или админа");
  }

  const reason = input.reason.trim().slice(0, 500);
  if (reason.length === 0) throw new Error("Укажите причину исключения");

  // Clear the titles first. Doing it in this order means there is no window in
  // which somebody rejected from the party still holds a role: were it the other
  // way round, an account that is already locked out of the portal could still be
  // counted as an appointable member, which is what the guard above measures.
  if (targetRoles.length > 0) {
    const { error: roleError } = await getSupabaseAdmin().rpc("set_profile_roles", {
      p_steam_id: input.steamId,
      // An empty set, not `["member"]`: the RPC stores appointments only.
      p_roles: [],
      p_actor: actor.steamId,
    });

    if (roleError) throw queryError("Не удалось снять роли участника", roleError);
  }

  const { error } = await getSupabaseAdmin()
    .from("profiles")
    .update({ status: "rejected", approved_at: null })
    .eq("steam_id", input.steamId);

  if (error) throw queryError(`Не удалось исключить участника`, error);

  await writeAudit({
    actor: actor.steamId,
    action: "profile.remove",
    entity: "profiles",
    entityId: input.steamId,
    meta: { from: { roles: targetRoles, status: targetRow.status }, reason },
  });
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                 */
/* -------------------------------------------------------------------------- */

export async function getOwnAvailability(): Promise<AvailabilitySlot[]> {
  const session = await requireSession();
  const { data, error } = await getSupabaseAdmin()
    .from("member_availability")
    .select("id, steam_id, weekday, from_min, to_min")
    .eq("steam_id", session.steamId)
    .order("weekday", { ascending: true })
    .order("from_min", { ascending: true });

  if (error) throw queryError(`Failed to read availability`, error);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    steamId: String(row.steam_id),
    weekday: Number(row.weekday),
    fromMin: Number(row.from_min),
    toMin: Number(row.to_min),
  }));
}

/**
 * Replace the caller's whole availability week.
 *
 * Delete-then-insert rather than a diff: the payload is at most a couple of dozen
 * rows, and a full replace removes any possibility of a stale row surviving an
 * edit or a deleted day lingering in the database.
 */
export async function replaceOwnAvailability(
  slots: Array<{ weekday: number; fromMin: number; toMin: number }>,
): Promise<AvailabilitySlot[]> {
  const session = await requireSession();
  await assertCan(session, "availability.editOwn");

  const admin = getSupabaseAdmin();

  const cleaned = slots
    .map((slot) => ({
      weekday: Math.trunc(slot.weekday),
      fromMin: Math.trunc(slot.fromMin),
      toMin: Math.trunc(slot.toMin),
    }))
    .filter((slot) => slot.weekday >= 0 && slot.weekday <= 6)
    .filter((slot) => slot.fromMin >= 0 && slot.fromMin < 1440 && slot.toMin <= 1440)
    .filter((slot) => slot.toMin > slot.fromMin);

  const { error: deleteError } = await admin
    .from("member_availability")
    .delete()
    .eq("steam_id", session.steamId);

  if (deleteError) throw queryError(`Failed to clear availability`, deleteError);

  if (cleaned.length > 0) {
    const { error: insertError } = await admin
      .from("member_availability")
      .insert(
        cleaned.map((slot) => ({
          steam_id: session.steamId,
          weekday: slot.weekday,
          from_min: slot.fromMin,
          to_min: slot.toMin,
        })),
      );

    if (insertError) throw queryError(`Failed to save availability`, insertError);
  }

  return getOwnAvailability();
}

/** The "who is free when" grid. Staff only — it exposes every member's week. */
export async function getAvailabilityMatrix(): Promise<AvailabilityMatrixRow[]> {
  await requirePermission("availability.viewAll");
  const admin = getSupabaseAdmin();

  // No `role` column: see the note on `ACCOUNT_COLUMNS`. The grid shows a stack of
  // badges, and it can only show what the assignment rows say.
  const [{ data: people, error: peopleError }, { data: slots, error: slotsError }] =
    await Promise.all([
      admin
        .from("profiles")
        .select("steam_id, display_name, persona, status")
        .order("display_name", { ascending: true }),
      admin.from("member_availability").select("steam_id, weekday, from_min, to_min"),
    ]);

  if (peopleError) throw queryError(`Failed to read members`, peopleError);
  if (slotsError) throw queryError(`Failed to read availability`, slotsError);

  const byMember = new Map<string, AvailabilitySlot[]>();
  for (const row of (slots ?? []) as unknown as Array<Record<string, unknown>>) {
    const steamId = String(row.steam_id);
    const list = byMember.get(steamId) ?? [];
    list.push({
      id: "",
      steamId,
      weekday: Number(row.weekday),
      fromMin: Number(row.from_min),
      toMin: Number(row.to_min),
    });
    byMember.set(steamId, list);
  }

  const peopleRows = (people ?? []) as unknown as Array<Record<string, unknown>>;
  const roleSets = await readRoleSets(peopleRows.map((row) => String(row.steam_id)));

  return peopleRows.map((row) => {
    const roles = normalizeRoles(roleSets.get(String(row.steam_id)) ?? []);
    return {
      steamId: String(row.steam_id),
      name: displayNameOf({ displayName: String(row.display_name ?? ""), persona: String(row.persona ?? "") }),
      roles,
      role: roles[0],
      status: row.status as AvailabilityMatrixRow["status"],
      slots: (byMember.get(String(row.steam_id)) ?? []).sort(
        (a, b) => a.weekday - b.weekday || a.fromMin - b.fromMin,
      ),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* Schedule / events                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Columns every read of `party_events` needs.
 *
 * `created_by` is deliberately *not* in this list. It was added to the database by
 * a migration that has to be applied to the live project by hand, so at runtime the
 * column may or may not be there. When it was listed here, its absence took down
 * the entire schedule and the landing page — a cosmetic "who scheduled this" label
 * should never be able to do that. It is added per query instead, once
 * `hasCreatedByColumn` has confirmed the database actually has it.
 */
const EVENT_COLUMNS =
  "id, title, description, location, starts_at, ends_at, rsvp_limit, is_published, " +
  "status, track_hours, require_rsvp, closed_at, closed_by";

const PUBLIC_EVENT_COLUMNS =
  "id, title, description, location, starts_at, ends_at, status, track_hours";

/** Soft-delete marker. Read through a probe, like `created_by`. */
const DELETED_AT = "deleted_at";

const CREATED_BY = "created_by";

/** How long a missing `created_by` is remembered before looking again. */
const CREATED_BY_PROBE_TTL_MS = 60_000;

let createdByProbe: { at: number; present: boolean } | null = null;
let deletedAtProbe: { at: number; present: boolean } | null = null;
let declinesTableProbe: boolean | null = null;

/**
 * Whether the live database has the soft-delete column.
 *
 * Probed for the same reason as `created_by` and with the same trade-off: a live
 * database can predate the newest migration, and a schedule that refuses to render
 * because of one missing column is worse than one that renders without it. A
 * missing column means "nothing is hidden", which is exactly the pre-migration
 * behaviour, so the fallback is the safe direction.
 */
async function hasDeletedAtColumn(
  admin: ReturnType<typeof getSupabaseAdmin>,
): Promise<boolean> {
  if (deletedAtProbe?.present) return true;
  const now = Date.now();
  if (deletedAtProbe && now - deletedAtProbe.at < CREATED_BY_PROBE_TTL_MS) {
    return deletedAtProbe.present;
  }

  const { error } = await admin.from("party_events").select(DELETED_AT).limit(1);
  const present = !error;

  if (!present) {
    console.warn(
      "[portal] party_events.deleted_at отсутствует: удалённые события не скрываются. " +
        "Примените supabase/migrations/002_portal.sql.",
    );
  }

  deletedAtProbe = { at: now, present };
  return present;
}

/**
 * Whether the live database has `party_events.created_by`.
 *
 * A success is remembered for the lifetime of the process: the column does not
 * disappear. A failure is re-checked once a minute, so applying the migration is
 * enough to make the author appear — no redeploy and no server restart.
 *
 * The failure is logged rather than swallowed. Running on a half-migrated database
 * is a real problem, and the warning is the only trace of it once the schedule
 * itself has stopped complaining.
 */
async function hasCreatedByColumn(
  admin: ReturnType<typeof getSupabaseAdmin>,
): Promise<boolean> {
  if (createdByProbe?.present) return true;
  const now = Date.now();
  if (createdByProbe && now - createdByProbe.at < CREATED_BY_PROBE_TTL_MS) {
    return createdByProbe.present;
  }

  const { error } = await admin.from("party_events").select(CREATED_BY).limit(1);
  const present = !error;

  if (!present) {
    console.warn(
      "[portal] party_events.created_by отсутствует: события читаются без автора, " +
        "новые сохраняются без него. Примените supabase/migrations/002_portal.sql.",
    );
  }

  createdByProbe = { at: now, present };
  return present;
}

/** The event columns to request, with the author only if it can be read. */
function eventColumns(withAuthor: boolean): string {
  return withAuthor ? `${EVENT_COLUMNS}, ${CREATED_BY}` : EVENT_COLUMNS;
}

/** The event columns plus whichever optional columns the database actually has. */
function eventColumnsWith(
  withAuthor: boolean,
  withDeletedAt: boolean,
): string {
  const extra = [withAuthor ? CREATED_BY : null, withDeletedAt ? DELETED_AT : null].filter(
    (column): column is string => column !== null,
  );
  return extra.length > 0 ? `${EVENT_COLUMNS}, ${extra.join(", ")}` : EVENT_COLUMNS;
}

/**
 * What an event looks like to a human, derived from the clock rather than from
 * `status`.
 *
 * The implementation lives in app/lib/portal/event-state.ts, which is client-safe:
 * the closing dialog needs the same duration calculation to cap the hours slider,
 * and importing it from here would drag `server-only` into a client component.
 */
export { eventState, eventDurationHours } from "@/lib/portal/event-state";

function toEventRecord(
  row: Record<string, unknown>,
  now: number = Date.now(),
): EventRecord {
  const status = (row.status ?? "draft") as EventRecord["status"];
  const startsAt = String(row.starts_at ?? "");
  const endsAt = (row.ends_at as string | null) ?? null;

  return {
    id: String(row.id),
    title: String(row.title ?? ""),
    description: String(row.description ?? ""),
    location: String(row.location ?? ""),
    startsAt,
    endsAt,
    rsvpLimit: row.rsvp_limit == null ? null : Number(row.rsvp_limit),
    isPublished: row.is_published === true,
    status,
    trackHours: row.track_hours !== false,
    requireRsvp: row.require_rsvp !== false,
    closedAt: (row.closed_at as string | null) ?? null,
    closedBy: (row.closed_by as string | null) ?? null,
    state: eventState(status, startsAt, endsAt, now),
    deletedAt: (row.deleted_at as string | null) ?? null,
    createdBy: (row.created_by as string | null) ?? null,
  };
}

/**
 * The schedule. Members see published events only; staff additionally see
 * `draft` ones, which are otherwise invisible. Soft-deleted events are hidden from
 * both, and `listDeletedEvents` is the only way back to them.
 */
/**
 * Project one `profiles` row plus its hours into a registry entry, applying the
 * contact-visibility rule here rather than in the component.
 *
 * The stripping happens server-side on purpose. A registry that *fetched*
 * everyone's Telegram and Discord handle and then blanked it in the view would
 * ship every member's contact details to every browser, and the only thing
 * standing between that data and a member's screen would be a conditional in
 * JSX — which is exactly the kind of check that gets dropped in a later refactor.
 * Here, a non-staff viewer who is not the owner simply never receives the column
 * values to hide.
 */
function toRegistryEntry(
  row: Record<string, unknown>,
  viewer: { staff: boolean; viewerId: string },
  hours: { totalHours: number; eventsAttended: number; eventsAbsent: number },
  roles: Role[],
): RegistryEntry {
  const steamId = String(row.steam_id);
  const contactsPublic = Boolean(row.contacts_public);
  const maySee = viewer.staff || contactsPublic || steamId === viewer.viewerId;
  const held = normalizeRoles(roles);

  return {
    steamId,
    displayName: String(row.display_name ?? ""),
    persona: String(row.persona ?? ""),
    roles: held,
    role: held[0],
    status: row.status as ApprovalStatus,
    about: String(row.about ?? ""),
    telegram: maySee ? ((row.telegram as string | null) ?? null) : null,
    discord: maySee ? ((row.discord as string | null) ?? null) : null,
    phone: maySee ? ((row.phone as string | null) ?? null) : null,
    contactsPublic,
    createdAt: String(row.created_at),
    approvedAt: (row.approved_at as string | null) ?? null,
    totalHours: hours.totalHours,
    eventsAttended: hours.eventsAttended,
    eventsAbsent: hours.eventsAbsent,
  };
}

/**
 * Everyone who unsubscribed, grouped by event, newest decline first.
 *
 * Two decisions live here rather than in the component:
 *
 *   1. `reason` is stripped for non-staff callers. The names stay, because they
 *      are no more private than the attendance list the same members already see,
 *      but a reason can read "полежал в больнице" or "нет денег на дорогу" and that
 *      belongs to staff. Blanking it in JSX would mean the string had already been
 *      shipped to the browser, leaving one careless refactor away from leaking it.
 *
 *   2. A missing `event_declines` table degrades to an empty list instead of
 *      failing the whole schedule. Someone who has not run the migration yet
 *      should still see their events; they simply will not have the decline list
 *      until they do.
 */
async function loadDeclines(
  admin: ReturnType<typeof getSupabaseAdmin>,
  ids: string[],
  staff: boolean,
): Promise<Map<string, DeclineRecord[]>> {
  if (ids.length === 0) return new Map();
  if (declinesTableProbe === false) return new Map();

  const { data, error } = await admin
    .from("event_declines")
    .select("event_id, steam_id, reason, created_at")
    .in("event_id", ids)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingObject(error)) {
      declinesTableProbe = false;
      console.warn(
        "[portal] таблица event_declines отсутствует: список отписок пуст. " +
          "Примените supabase/migrations/002_portal.sql.",
      );
      return new Map();
    }
    throw queryError("Failed to read event declines", error);
  }

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const names = await loadMemberNames(rows.map((row) => String(row.steam_id)));

  const grouped = new Map<string, DeclineRecord[]>();
  for (const row of rows) {
    const eventId = String(row.event_id);
    const steamId = String(row.steam_id);
    const list = grouped.get(eventId) ?? [];
    list.push({
      steamId,
      name: names.get(steamId) ?? steamId,
      reason: staff ? String(row.reason ?? "") : null,
      createdAt: String(row.created_at ?? ""),
    });
    grouped.set(eventId, list);
  }

  return grouped;
}

/** Events a staff member hid, so they can be brought back. Staff only. */
export async function listDeletedEvents(): Promise<EventWithAttendance[]> {
  const actor = await requireSession();
  // Reading the trash is part of being able to delete, not a separate power: an
  // event cannot be restored by someone who may not delete.
  await assertCan(actor, "event.deleteAny");

  const admin = getSupabaseAdmin();
  if (!(await hasDeletedAtColumn(admin))) return [];

  const now = Date.now();
  const { data, error } = await admin
    .from("party_events")
    .select(eventColumnsWith(false, true))
    .not("deleted_at", "is", null)
    .order("starts_at", { ascending: false });

  if (error) throw queryError("Failed to read deleted events", error);

  const events = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(
    (row) => toEventRecord(row, now),
  );
  if (events.length === 0) return [];

  const ids = events.map((event) => event.id);
  const { data: attendance, error: attendanceError } = await admin
    .from("event_attendance")
    .select("event_id, steam_id, status, hours, note")
    .in("event_id", ids);

  if (attendanceError) throw queryError("Failed to read attendance", attendanceError);

  const rows = (attendance ?? []) as unknown as Array<Record<string, unknown>>;
  const names = await loadMemberNames(rows.map((row) => String(row.steam_id)));
  const declines = await loadDeclines(admin, ids, true);

  const byEvent = new Map<string, AttendanceRecord[]>();
  for (const row of rows) {
    const eventId = String(row.event_id);
    const steamId = String(row.steam_id);
    const list = byEvent.get(eventId) ?? [];
    list.push({
      steamId,
      name: names.get(steamId) ?? steamId,
      status: row.status as AttendanceRecord["status"],
      hours: num(row.hours),
      note: (row.note as string | null) ?? null,
    });
    byEvent.set(eventId, list);
  }

  return events.map((event) => {
    const list = (byEvent.get(event.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const eventDeclines = declines.get(event.id) ?? [];

    return {
      ...event,
      attendance: list,
      declines: eventDeclines,
      totalHours: list
        .filter((entry) => entry.status === "attended")
        .reduce((sum, entry) => sum + entry.hours, 0),
      attendedCount: list.filter((entry) => entry.status === "attended").length,
      absentCount: list.filter((entry) => entry.status === "absent").length,
      ownStatus: list.find((entry) => entry.steamId === actor.steamId)?.status ?? null,
      ownDecline: eventDeclines.find((entry) => entry.steamId === actor.steamId) ?? null,
    };
  });
}

export async function listEvents(): Promise<EventWithAttendance[]> {
  const session = await requireSession();
  const staff = await canAct(session, "event.editAny");
  const now = Date.now();

  const admin = getSupabaseAdmin();

  const withDeletedAt = await hasDeletedAtColumn(admin);
  const withCreatedBy = await hasCreatedByColumn(admin);
  let query = admin.from("party_events").select(eventColumnsWith(withCreatedBy, withDeletedAt));

  if (withDeletedAt) query = query.is("deleted_at", null);

  if (!staff && withCreatedBy) {
    // `is_published` alone is not enough. Publication is a separate switch from
    // status, so a draft that someone ticked "publish" on would otherwise be
    // listed to every member — the opposite of what a draft is for. Non-staff
    // always see open and finished events, never drafts.
    //
    // Their *own* drafts are the exception, or an event would have to be
    // published the instant it was created and there would be no way to prepare
    // one privately. The alternative shape — a second query for the caller's rows,
    // then a merge — was avoided because it duplicates the ordering and the
    // attendance join below; PostgREST's `or` keeps one result set.
    query = query.or(
      `and(is_published.eq.true,status.neq.draft),created_by.eq.${session.steamId}`,
    );
  } else if (!staff) {
    query = query.eq("is_published", true).neq("status", "draft");
  }

  const { data, error } = await query.order("starts_at", { ascending: true });
  if (error) throw queryError("Failed to read events", error);

  const events = ((data ?? []) as unknown as Array<Record<string, unknown>>).map(
    (row) => toEventRecord(row, now),
  );
  if (events.length === 0) return [];

  const ids = events.map((event) => event.id);

  const { data: attendance, error: attendanceError } = await admin
    .from("event_attendance")
    .select("event_id, steam_id, status, hours, note")
    .in("event_id", ids);

  if (attendanceError) {
    throw queryError("Failed to read attendance", attendanceError);
  }

  const rows = (attendance ?? []) as unknown as Array<Record<string, unknown>>;
  const names = await loadMemberNames(rows.map((row) => String(row.steam_id)));

  const byEvent = new Map<string, AttendanceRecord[]>();
  for (const row of rows) {
    const eventId = String(row.event_id);
    const steamId = String(row.steam_id);
    const list = byEvent.get(eventId) ?? [];
    list.push({
      steamId,
      name: names.get(steamId) ?? steamId,
      status: row.status as AttendanceRecord["status"],
      hours: num(row.hours),
      note: (row.note as string | null) ?? null,
    });
    byEvent.set(eventId, list);
  }

  const declinesByEvent = await loadDeclines(admin, ids, staff);

  return events.map((event) => {
    const list = (byEvent.get(event.id) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const declines = declinesByEvent.get(event.id) ?? [];
    const totalHours = list
      .filter((entry) => entry.status === "attended")
      .reduce((sum, entry) => sum + entry.hours, 0);

    return {
      ...event,
      attendance: list,
      declines,
      totalHours,
      attendedCount: list.filter((entry) => entry.status === "attended").length,
      absentCount: list.filter((entry) => entry.status === "absent").length,
      ownStatus: list.find((entry) => entry.steamId === session.steamId)?.status ?? null,
      ownDecline: declines.find((entry) => entry.steamId === session.steamId) ?? null,
    };
  });
}

/** Create or edit an event. Staff only. */
export async function upsertEvent(input: EventUpsertInput): Promise<EventRecord> {
  const actor = await requireSession();
  const admin = getSupabaseAdmin();
  // On a database that predates the column the event is still created, just
  // without an author. Refusing to schedule anything until a migration is applied
  // would be a far worse trade than a missing name.
  const withAuthor = await hasCreatedByColumn(admin);

  if (input.id) {
    // Editing is not creating. The person who scheduled an event keeps the right
    // to fix a typo in it on the strength of `event.create` — the same permission
    // that let them write it in the first place — and editing somebody else's
    // needs `event.editAny` on top. Reading the row first is unavoidable: who owns
    // an event is a fact about the event.
    const { data: existing, error: readError } = await admin
      .from("party_events")
      .select(withAuthor ? "created_by" : "id")
      .eq("id", input.id)
      .maybeSingle();
    if (readError) throw queryError("Не удалось прочитать мероприятие", readError);
    if (!existing) throw new Error("Мероприятие не найдено");

    const isAuthor =
      withAuthor && (existing as { created_by?: string | null }).created_by === actor.steamId;
    const asOrganiser = isAuthor && (await canAct(actor, "event.create"));
    if (!(await canAct(actor, "event.editAny")) && !asOrganiser) {
      throw new SessionError("forbidden");
    }
  } else {
    await assertCan(actor, "event.create");
  }

  if (input.endsAt && new Date(input.endsAt) <= new Date(input.startsAt)) {
    throw new Error("Окончание должно быть позже начала");
  }

  const payload = {
    // Truncated rather than rejected so a paste that overruns by a character does
    // not lose the whole event, but the bound is a real one: the card on the
    // public schedule has room for a line and a bit, so a 200-character title was
    // being cut off by CSS rather than by a rule anybody could read.
    title: input.title.trim().slice(0, EVENT_TITLE_MAX),
    description: input.description.trim().slice(0, EVENT_DESCRIPTION_MAX),
    location: input.location.trim().slice(0, 200),
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    rsvp_limit: input.rsvpLimit,
    is_published: input.isPublished,
    status: input.status,
    track_hours: input.trackHours,
    require_rsvp: input.requireRsvp,
    // Stamped on insert only. An update must not rewrite the author, otherwise
    // whoever last edited an event would be credited with scheduling it, and the
    // public schedule would name the wrong organiser.
    ...(!input.id && withAuthor ? { created_by: actor.steamId } : {}),
  };

  if (!payload.title) throw new Error("Введите название мероприятия");

  const query = input.id
    ? admin.from("party_events").update(payload).eq("id", input.id)
    : admin.from("party_events").insert(payload);

  const { data, error } = await query.select(eventColumns(withAuthor)).single();
  if (error || !data) {
    throw queryError("Не удалось сохранить мероприятие", error ?? { message: "not found" });
  }

  await writeAudit({
    actor: actor.steamId,
    action: input.id ? "event.update" : "event.create",
    entity: "party_events",
    entityId: toEventRecord(data as unknown as Record<string, unknown>).id,
    meta: { title: payload.title },
  });

  return toEventRecord(data as unknown as Record<string, unknown>);
}

/**
 * Join or leave an event. Any approved member; the row is keyed on the session.
 *
 * Leaving requires a reason. That is the whole reason `event_declines` is a table
 * rather than a deleted row: "человек отписался" is not information, whereas "не
 * смог прийти, был в командировке" is what lets staff either fix the date or stop
 * scheduling at the same slot. The old `require_rsvp` guard made the leave
 * impossible for everyone, so the list of people who said they would come was
 * quietly overstated right up until the day.
 *
 * The clock gate applies to both directions on purpose. Allowing a join until the
 * event starts but a leave only before would strand anyone who signed up and then
 * could not come once the meeting began, which is exactly when they most need to
 * get out of the headcount.
 */
export async function setOwnRsvp(input: RsvpInput): Promise<void> {
  const session = await requireSession();
  await assertCan(session, "event.rsvp");

  const admin = getSupabaseAdmin();

  const { data: event } = await admin
    .from("party_events")
    .select("status, rsvp_limit, starts_at, deleted_at")
    .eq("id", input.eventId)
    .maybeSingle();

  if (!event) throw new Error("Мероприятие не найдено");
  const row = event as {
    status: string;
    rsvp_limit: number | null;
    starts_at: string;
    deleted_at: string | null;
  };

  if (row.deleted_at) throw new Error("Мероприятие удалено");
  if (row.status !== "open") throw new Error("Мероприятие уже закрыто для записи");

  const starts = new Date(row.starts_at).getTime();
  if (!Number.isNaN(starts) && Date.now() >= starts) {
    throw new Error(
      "Мероприятие уже началось — запись закрыта, отметьтесь у организаторов",
    );
  }

  if (input.attending && row.rsvp_limit != null) {
    const { count } = await admin
      .from("event_attendance")
      .select("steam_id", { count: "exact", head: true })
      .eq("event_id", input.eventId);

    if ((count ?? 0) >= row.rsvp_limit) throw new Error("Все места заняты");
  }

  if (input.attending) {
    const { error } = await admin
      .from("event_attendance")
      .upsert(
        { event_id: input.eventId, steam_id: session.steamId, status: "rsvp", hours: 0 },
        { onConflict: "event_id,steam_id" },
      );
    if (error) throw queryError("Не удалось записаться", error);

    // A member who changes their mind and signs up again must not leave a stale
    // decline — and its reason — sitting next to their name in the staff list.
    //
    // A failure here is logged, not thrown. The attendance row is already written,
    // so the join succeeded; reporting "не удалось записаться" to a member who is
    // demonstrably on the list is worse than a duplicate line, and the only visible
    // cost of the latter is one extra line in the staff view. A missing table is the
    // expected case here and means there is nothing to clear in the first place.
    const { error: clearDeclineError } = await admin
      .from("event_declines")
      .delete()
      .eq("event_id", input.eventId)
      .eq("steam_id", session.steamId);
    if (clearDeclineError) {
      if (isMissingObject(clearDeclineError)) {
        declinesTableProbe = false;
      } else {
        console.warn(
          `[portal] не удалось снять отписку при повторной записи на событие ${input.eventId}:`,
          clearDeclineError.message,
        );
      }
    } else {
      declinesTableProbe = true;
    }
  } else {
    const reason = (input.reason ?? "").trim();
    if (!reason) throw new Error("Укажите причину отписки");
    if (reason.length > 500) throw new Error("Причина отписки слишком длинная");

    const { error: leaveError } = await admin
      .from("event_attendance")
      .delete()
      .eq("event_id", input.eventId)
      .eq("steam_id", session.steamId);
    if (leaveError) throw queryError("Не удалось отписаться", leaveError);

    const { error: declineError } = await admin.from("event_declines").upsert(
      { event_id: input.eventId, steam_id: session.steamId, reason },
      { onConflict: "event_id,steam_id" },
    );
    if (declineError) {
      if (isMissingObject(declineError)) declinesTableProbe = false;
      throw queryError("Не удалось отписаться", declineError);
    }
    declinesTableProbe = true;
  }

  await writeAudit({
    actor: session.steamId,
    action: input.attending ? "event.rsvp.join" : "event.rsvp.leave",
    entity: "party_events",
    entityId: input.eventId,
    ...(input.attending
      ? {}
      : { meta: { reason: (input.reason ?? "").trim().slice(0, 500) } }),
  });
}

/**
 * Record attendance and hours for one event, then mark it finished.
 *
 * `upsert` rather than `update`, because the closing dialog always resubmits the
 * full attendance list, and because re-closing a finished event must correct the
 * existing rows instead of failing on the primary key. The decision to allow that
 * at all is deliberate: hours get entered from memory after a shift, and a leader
 * needs to fix a mistake — but every write lands in the audit log, so the
 * correction is attributable.
 */
export async function recordAttendance(input: {
  eventId: string;
  rows: AttendanceInput[];
  totalHours?: number | null;
}): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "event.close");

  const admin = getSupabaseAdmin();

  const { data: event } = await admin
    .from("party_events")
    .select("track_hours, status")
    .eq("id", input.eventId)
    .maybeSingle();

  if (!event) throw new Error("Мероприятие не найдено");
  const trackHours = (event as { track_hours: boolean; status: string }).track_hours !== false;
  const wasFinished = (event as { track_hours: boolean; status: string }).status === "finished";

  const normalised = input.rows
    .map((row) => ({
      steam_id: row.steamId,
      status: row.status,
      hours: trackHours ? Math.max(0, Math.min(1440, num(row.hours))) : 0,
      note: row.note.trim().slice(0, 500) || null,
    }))
    // A member who only ever RSVP'd and was never marked present or absent has no
    // line to write. Keeping the row as `rsvp` would freeze them at zero hours and
    // they would vanish from both the attended and the absent count.
    .filter((row) => row.status === "attended" || row.status === "absent");

  if (normalised.length > 0) {
    const { error } = await admin.from("event_attendance").upsert(
      normalised.map((row) => ({ ...row, event_id: input.eventId })),
      { onConflict: "event_id,steam_id" },
    );
    if (error) throw queryError(`Не удалось сохранить часы`, error);
  }

  // Nobody left as `rsvp` is genuinely "absent" — they simply never turned up and
  // nobody recorded them. Clear those rows so the absent list stays honest.
  const { error: clearError } = await admin
    .from("event_attendance")
    .delete()
    .eq("event_id", input.eventId)
    .eq("status", "rsvp");

  if (clearError) {
    throw queryError(`Не удалось убрать незакрытые отметки`, clearError);
  }

  const { error: closeError } = await admin
    .from("party_events")
    .update({
      status: "finished",
      closed_at: new Date().toISOString(),
      closed_by: actor.steamId,
    })
    .eq("id", input.eventId);

  if (closeError) throw queryError(`Не удалось закрыть мероприятие`, closeError);

  const computedTotal = normalised
    .filter((row) => row.status === "attended")
    .reduce((sum, row) => sum + row.hours, 0);

  await writeAudit({
    actor: actor.steamId,
    action: wasFinished ? "event.editHours" : "event.close",
    entity: "party_events",
    entityId: input.eventId,
    meta: {
      attended: normalised.filter((row) => row.status === "attended").length,
      absent: normalised.filter((row) => row.status === "absent").length,
      totalHours: computedTotal,
      statedTotal: input.totalHours ?? null,
    },
  });
}

/**
 * Hide an event, for staff only, whether it is still upcoming or long finished.
 *
 * This is deliberately an UPDATE and not a DELETE. A finished event owns
 * `event_attendance` rows, and `member_hours_totals` is a view over exactly those
 * rows — so a hard delete would silently strip hours that members already worked
 * and that the council may have already counted towards something. It would also
 * be unrecoverable, since the audit log records that a delete happened but not
 * what was in the row.
 *
 * Both writes keep the row and its history; the event simply stops appearing in
 * every list, public and internal, until `restoreEvent` puts it back.
 */
export async function deleteEvent(id: string): Promise<void> {
  const actor = await requireSession();
  const admin = getSupabaseAdmin();

  if (!(await hasDeletedAtColumn(admin))) {
    throw queryError("Не удалось удалить мероприятие", {
      code: "42703",
      message: "party_events.deleted_at отсутствует",
    });
  }

  // Read before deciding, because "may I" is now a question about the row and not
  // only about the caller. `created_by` is probed rather than assumed: a member
  // who created an event may remove it, and a database that predates the column
  // has nobody to attribute those rows to.
  const withCreatedBy = await hasCreatedByColumn(admin);
  const { data: before, error: readError } = await admin
    .from("party_events")
    .select(`status, is_published, deleted_at${withCreatedBy ? ", created_by" : ""}`)
    .eq("id", id)
    .maybeSingle();
  if (readError) throw queryError("Не удалось удалить мероприятие", readError);
  if (!before) throw new Error("Мероприятие не найдено");

  const previous = before as unknown as {
    status: string;
    is_published: boolean;
    deleted_at: string | null;
    created_by?: string | null;
  };

  // An event with no `created_by` was written before members could create events,
  // so nobody owns it and it stays staff-only. Treated as staff-only rather than
  // as orphaned: a null author is not evidence of permission.
  const isAuthor = withCreatedBy && previous.created_by === actor.steamId;
  if (!(await canAct(actor, "event.deleteAny")) && !isAuthor) {
    throw new SessionError("forbidden");
  }

  if (previous.deleted_at) return;

  const { error } = await admin
    .from("party_events")
    .update({ deleted_at: new Date().toISOString(), is_published: false })
    .eq("id", id);
  if (error) throw queryError("Не удалось удалить мероприятие", error);

  await writeAudit({
    actor: actor.steamId,
    // As with work points: the log records a removal, and the permission that
    // permits one is the `Any` variant, staff or not.
    action: "event.deleteAny",
    entity: "party_events",
    entityId: id,
    meta: {
      soft: true,
      previousStatus: previous.status,
      previousPublished: previous.is_published,
    },
  });
}

/** Bring a hidden event back. Staff only, reusing `event.editAny`. */
export async function restoreEvent(id: string): Promise<void> {
  const actor = await requireSession();
  // Restoring is not available to the event's own author: `deleteEvent` hides a row
  // precisely so staff can look at it, and letting the author undo the hide would
  // make the trash unreviewable.
  await assertCan(actor, "event.editAny");

  const admin = getSupabaseAdmin();
  if (!(await hasDeletedAtColumn(admin))) {
    throw queryError("Не удалось восстановить мероприятие", {
      code: "42703",
      message: "party_events.deleted_at отсутствует",
    });
  }

  const { data, error } = await admin
    .from("party_events")
    .update({ deleted_at: null })
    .eq("id", id)
    .select("is_published")
    .single();
  if (error) throw queryError("Не удалось восстановить мероприятие", error);

  await writeAudit({
    actor: actor.steamId,
    action: "event.restore",
    entity: "party_events",
    entityId: id,
    // `is_published` is deliberately left as it was: restore should not
    // re-publish something that was unpublished before it was hidden.
    meta: { published: (data as { is_published: boolean }).is_published },
  });
}

/* -------------------------------------------------------------------------- */
/* Appeals                                                                      */
/* -------------------------------------------------------------------------- */

interface AppealRow {

  id: number | string;
  author: string;
  title: string;
  body: string;
  status: AppealStatus;
  staff_reply: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

async function listAppealsRows(): Promise<AppealRow[]> {
  const { data, error } = await getSupabaseAdmin()
    .from("appeals")
    .select("id, author, title, body, status, staff_reply, resolved_by, resolved_at, created_at, updated_at")
    .order("created_at", { ascending: false });

  if (error) throw queryError(`Failed to read appeals`, error);
  return (data ?? []) as AppealRow[];
}

export async function listAppeals(): Promise<AppealRecord[]> {
  const session = await requireSession();
  await assertCan(session, "appeal.create");

  const rows = await listAppealsRows();
  const names = await loadMemberNames(rows.map((row) => row.author));

  return rows.map((row) => ({
    id: String(row.id),
    author: row.author,
    authorName: names.get(row.author) ?? row.author,
    title: row.title,
    body: row.body,
    status: row.status,
    staffReply: row.staff_reply,
    resolvedBy: row.resolved_by,
    resolvedAt: row.resolved_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export async function createAppeal(input: { title: string; body: string }): Promise<void> {
  const session = await requireSession();
  await assertCan(session, "appeal.create");

  const title = input.title.trim();
  const body = input.body.trim();
  if (title.length < 3) throw new Error("Заголовок слишком короткий");
  if (body.length < 10) throw new Error("Текст обращения слишком короткий");

  const { error } = await getSupabaseAdmin()
    .from("appeals")
    .insert({ author: session.steamId, title, body });

  if (error) throw queryError(`Не удалось создать обращение`, error);

  await writeAudit({
    actor: session.steamId,
    action: "appeal.create",
    entity: "appeals",
    meta: { title },
  });
}

/**
 * Move an appeal to a new status.
 *
 * Deliberately open to every member, per the brief: the decision was that status
 * may be set by anyone. The consequence, stated plainly so it is a choice and not
 * a surprise, is that a member can mark their own or anyone's appeal `done` or
 * `rejected`. Restricting it is a one-line change in app/lib/permissions.ts if
 * that proves wrong in practice.
 */
export async function setAppealStatus(input: {
  id: string;
  status: AppealStatus;
}): Promise<void> {
  const session = await requireSession();
  await assertCan(session, "appeal.setStatus");

  const rows = await listAppealsRows();
  const target = rows.find((row) => String(row.id) === input.id);
  if (!target) throw new Error("Обращение не найдено");

  const resolved = input.status === "done" || input.status === "rejected";

  const { error } = await getSupabaseAdmin()
    .from("appeals")
    .update({
      status: input.status,
      resolved_at: resolved ? new Date().toISOString() : null,
      resolved_by: resolved ? session.steamId : null,
    })
    .eq("id", input.id);

  if (error) throw queryError(`Не удалось изменить статус`, error);

  await writeAudit({
    actor: session.steamId,
    action: "appeal.setStatus",
    entity: "appeals",
    entityId: input.id,
    meta: { from: target.status, to: input.status, label: APPEAL_STATUS_LABELS[input.status] },
  });
}

/** Staff reply. Staff only, unlike the status change above. */
export async function setAppealReply(input: { id: string; reply: string }): Promise<void> {
  const session = await requireSession();
  await assertCan(session, "appeal.reply");

  const reply = input.reply.trim().slice(0, 5000) || null;
  const { error } = await getSupabaseAdmin()
    .from("appeals")
    .update({ staff_reply: reply })
    .eq("id", input.id);

  if (error) throw queryError(`Не удалось сохранить ответ`, error);

  await writeAudit({
    actor: session.steamId,
    action: "appeal.reply",
    entity: "appeals",
    entityId: input.id,
  });
}

/**
 * Delete an appeal.
 *
 * The author may delete their own only while it is still open; once it is `done`
 * or `rejected` it records a decision the council took and only staff may remove
 * it. Ownership is decided by re-reading the row, never by trusting an
 * `isAuthor` flag from the request.
 */
export async function deleteAppeal(id: string): Promise<void> {
  const session = await requireSession();

  const { data } = await getSupabaseAdmin()
    .from("appeals")
    .select("author, status")
    .eq("id", id)
    .maybeSingle();

  if (!data) throw new Error("Обращение не найдено");
  const row = data as { author: string; status: string };

  const isAuthor = row.author === session.steamId;
  const asStaff = await canAct(session, "appeal.deleteAny");
  const asOwner =
    (await canAct(session, "appeal.deleteOwn", { isAuthor })) && isAppealOpen(row.status);

  if (!asStaff && !asOwner) throw new SessionError("forbidden");

  const { error } = await getSupabaseAdmin().from("appeals").delete().eq("id", id);
  if (error) throw queryError(`Не удалось удалить обращение`, error);

  await writeAudit({
    actor: session.steamId,
    action: asStaff && !isAuthor ? "appeal.deleteAny" : "appeal.deleteOwn",
    entity: "appeals",
    entityId: id,
    meta: { author: row.author, status: row.status },
  });
}

/* -------------------------------------------------------------------------- */
/* Polls                                                                        */
/* -------------------------------------------------------------------------- */

export async function listPolls(): Promise<PollRecord[]> {
  const session = await requireSession();
  await assertCan(session, "poll.create");

  const admin = getSupabaseAdmin();

  const { data: pollRows, error: pollError } = await admin
    .from("polls")
    .select("id, author, question, description, multiple, status, closes_at, created_at")
    .order("created_at", { ascending: false });

  if (pollError) throw queryError(`Не удалось прочитать опросы`, pollError);

  const polls = (pollRows ?? []) as unknown as Array<Record<string, unknown>>;
  if (polls.length === 0) return [];

  const pollIds = polls.map((row) => String(row.id));
  const names = await loadMemberNames(polls.map((row) => String(row.author)));

  const [{ data: optionRows, error: optionError }, { data: voteRows, error: voteError }] =
    await Promise.all([
      admin
        .from("poll_options")
        .select("id, poll_id, label, position")
        .in("poll_id", pollIds)
        .order("position", { ascending: true }),
      admin.from("poll_votes").select("poll_id, option_id, voter").in("poll_id", pollIds),
    ]);

  if (optionError) throw queryError(`Не удалось прочитать варианты`, optionError);
  if (voteError) throw queryError(`Не удалось прочитать голоса`, voteError);

  const votes = (voteRows ?? []) as unknown as Array<Record<string, unknown>>;

  const byCount = new Map<string, number>();
  const votersByPoll = new Map<string, Set<string>>();
  const ownByOption = new Map<string, boolean>();

  for (const vote of votes) {
    const pollId = String(vote.poll_id);
    const optionId = String(vote.option_id);
    byCount.set(optionId, (byCount.get(optionId) ?? 0) + 1);

    const voters = votersByPoll.get(pollId) ?? new Set<string>();
    voters.add(String(vote.voter));
    votersByPoll.set(pollId, voters);

    if (String(vote.voter) === session.steamId) ownByOption.set(optionId, true);
  }

  const optionsByPoll = new Map<string, PollOption[]>();
  for (const row of (optionRows ?? []) as unknown as Array<Record<string, unknown>>) {
    const pollId = String(row.poll_id);
    const optionId = String(row.id);
    const list = optionsByPoll.get(pollId) ?? [];
    list.push({
      id: optionId,
      label: String(row.label),
      position: Number(row.position ?? 0),
      votes: byCount.get(optionId) ?? 0,
      ownVote: ownByOption.get(optionId) === true,
    });
    optionsByPoll.set(pollId, list);
  }

  return polls.map((row) => {
    const id = String(row.id);
    const options = optionsByPoll.get(id) ?? [];
    return {
      id,
      author: String(row.author),
      authorName: names.get(String(row.author)) ?? String(row.author),
      question: String(row.question),
      description: String(row.description ?? ""),
      multiple: row.multiple === true,
      status: (row.status ?? "open") as PollRecord["status"],
      closesAt: (row.closes_at as string | null) ?? null,
      createdAt: String(row.created_at ?? ""),
      options,
      totalVotes: options.reduce((sum, option) => sum + (option.votes ?? 0), 0),
      voterCount: votersByPoll.get(id)?.size ?? 0,
    };
  });
}

/**
 * Create a poll with its options.
 *
 * The poll and its options are inserted in that order because `poll_options.poll_id`
 * references the poll. If the option insert fails, the orphaned poll is removed
 * before the error propagates, so a failed create cannot leave an option-less
 * poll in the list.
 */
export async function createPoll(input: {
  question: string;
  description: string;
  multiple: boolean;
  options: string[];
}): Promise<void> {
  const session = await requireSession();
  await assertCan(session, "poll.create");

  const question = input.question.trim();
  const labels = input.options.map((option) => option.trim()).filter((option) => option.length > 0);

  if (question.length < 3) throw new Error("Вопрос слишком короткий");
  if (labels.length < 2) throw new Error("Нужно минимум два варианта");
  if (labels.length > 12) throw new Error("Слишком много вариантов");

  const admin = getSupabaseAdmin();

  const { data: poll, error: pollError } = await admin
    .from("polls")
    .insert({
      author: session.steamId,
      question,
      description: input.description.trim().slice(0, 1000),
      multiple: input.multiple,
    })
    .select("id")
    .single();

  if (pollError || !poll) {
    throw queryError("Не удалось создать опрос", pollError ?? { message: "not found" });
  }

  const pollId = (poll as { id: number | string }).id;

  const { error: optionError } = await admin.from("poll_options").insert(
    labels.map((label, index) => ({ poll_id: pollId, label, position: index })),
  );

  if (optionError) {
    await admin.from("polls").delete().eq("id", pollId);
    throw queryError(`Не удалось сохранить варианты`, optionError);
  }

  await writeAudit({
    actor: session.steamId,
    action: "poll.create",
    entity: "polls",
    entityId: pollId,
    meta: { question, options: labels.length, multiple: input.multiple },
  });
}

/**
 * Cast or change a vote.
 *
 * The caller's previous votes for this poll are cleared first, which is what makes
 * a re-vote a change rather than a second ballot. The database enforces one row
 * per (poll, voter, option) with a unique constraint; the "at most one option
 * unless the poll is a multiple-choice one" rule has no such constraint, so it is
 * checked here against the freshly read poll row.
 */
export async function voteInPoll(input: {
  pollId: string;
  optionIds: string[];
}): Promise<void> {
  const session = await requireSession();
  await assertCan(session, "poll.vote");

  const admin = getSupabaseAdmin();

  const { data: poll } = await admin
    .from("polls")
    .select("status, multiple")
    .eq("id", input.pollId)
    .maybeSingle();

  if (!poll) throw new Error("Опрос не найден");
  const { status, multiple } = poll as { status: string; multiple: boolean };
  if (!isPollOpen(status)) throw new Error("Опрос закрыт");

  const unique = [...new Set(input.optionIds.filter((id) => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) throw new Error("Выберите вариант");
  if (!multiple && unique.length > 1) throw new Error("Этот опрос допускает только один вариант");

  const { data: validOptions } = await admin
    .from("poll_options")
    .select("id")
    .eq("poll_id", input.pollId)
    .in("id", unique);

  if ((validOptions ?? []).length !== unique.length) {
    throw new Error("Вариант не относится к этому опросу");
  }

  const { error: clearError } = await admin
    .from("poll_votes")
    .delete()
    .eq("poll_id", input.pollId)
    .eq("voter", session.steamId);

  if (clearError) throw queryError(`Не удалось обновить голос`, clearError);

  const { error: insertError } = await admin.from("poll_votes").insert(
    unique.map((optionId) => ({ poll_id: input.pollId, option_id: optionId, voter: session.steamId })),
  );

  if (insertError) throw queryError(`Не удалось сохранить голос`, insertError);

  await writeAudit({
    actor: session.steamId,
    action: "poll.vote",
    entity: "polls",
    entityId: input.pollId,
    meta: { options: unique.length },
  });
}

export async function setPollStatus(input: {
  pollId: string;
  status: "open" | "closed";
}): Promise<void> {
  const session = await requireSession();
  await assertCan(session, "poll.close");

  const { error } = await getSupabaseAdmin()
    .from("polls")
    .update({ status: input.status })
    .eq("id", input.pollId);

  if (error) throw queryError(`Не удалось изменить статус опроса`, error);

  await writeAudit({
    actor: session.steamId,
    action: "poll.setStatus",
    entity: "polls",
    entityId: input.pollId,
    meta: { status: input.status },
  });
}

export async function deletePoll(pollId: string): Promise<void> {
  const session = await requireSession();

  const { data } = await getSupabaseAdmin()
    .from("polls")
    .select("author, status")
    .eq("id", pollId)
    .maybeSingle();

  if (!data) throw new Error("Опрос не найден");
  const row = data as { author: string; status: string };

  const isAuthor = row.author === session.steamId;
  const asStaff = await canAct(session, "poll.deleteAny");
  const asOwner =
    (await canAct(session, "poll.deleteOwn", { isAuthor })) && isPollOpen(row.status);

  if (!asStaff && !asOwner) throw new SessionError("forbidden");

  const { error } = await getSupabaseAdmin().from("polls").delete().eq("id", pollId);
  if (error) throw queryError(`Не удалось удалить опрос`, error);

  await writeAudit({
    actor: session.steamId,
    action: asStaff && !isAuthor ? "poll.deleteAny" : "poll.deleteOwn",
    entity: "polls",
    entityId: pollId,
    meta: { author: row.author },
  });
}

/* -------------------------------------------------------------------------- */
/* Work points                                                                  */
/* -------------------------------------------------------------------------- */

export async function listWorkPoints(): Promise<WorkPointRecord[]> {
  const session = await requireSession();
  const staff = await canAct(session, "point.editAny");

  let query = getSupabaseAdmin().from("work_points").select("*");
  // Members see published points plus their own drafts, for the same reason they
  // see their own event drafts: `point.create` is granted to whoever maintains the
  // map, and a half-finished marker should not be visible to the whole party until
  // it is ready. One query rather than a merge, so the ordering and the name
  // lookup below stay single-passed.
  if (!staff) {
    query = query.or(`status.eq.published,created_by.eq.${session.steamId}`);
  }

  const { data, error } = await query.order("created_at", { ascending: false });
  if (error) throw queryError(`Не удалось прочитать точки`, error);

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const names = await loadMemberNames(rows.map((row) => String(row.created_by)));

  return rows.map((row) => {
    const createdBy = String(row.created_by);
    return {
      id: String(row.id),
      title: String(row.title ?? ""),
      description: String(row.description ?? ""),
      imgurUrl: String(row.imgur_url ?? ""),
      kind: (row.kind ?? "work") as WorkPointRecord["kind"],
      xPct: num(row.x_pct),
      yPct: num(row.y_pct),
      status: (row.status ?? "published") as WorkPointRecord["status"],
      createdBy,
      createdByName: names.get(createdBy) ?? createdBy,
      createdAt: String(row.created_at ?? ""),
    };
  });
}

export async function upsertWorkPoint(input: WorkPointInput): Promise<void> {
  const actor = await requireSession();
  const admin = getSupabaseAdmin();

  if (input.id) {
    // Editing is not creating: the person who marked a point may fix it on the
    // strength of `point.create`, and changing somebody else's marker needs
    // `point.editAny`. Ownership is read from the row, so this cannot be a
    // header-level check.
    const { data: existing, error: readError } = await admin
      .from("work_points")
      .select("created_by")
      .eq("id", input.id)
      .maybeSingle();
    if (readError) throw queryError("Не удалось прочитать точку", readError);
    if (!existing) throw new Error("Точка не найдена");

    const isAuthor = (existing as { created_by?: string | null }).created_by === actor.steamId;
    const asAuthor = isAuthor && (await canAct(actor, "point.create"));
    if (!(await canAct(actor, "point.editAny")) && !asAuthor) {
      throw new SessionError("forbidden");
    }
  } else {
    await assertCan(actor, "point.create");
  }

  const title = input.title.trim();
  const imgurUrl = input.imgurUrl.trim();
  if (title.length < 2) throw new Error("Слишком короткое название");
  if (!/^https?:\/\//i.test(imgurUrl)) throw new Error("Нужна ссылка на фото, начинающаяся с http");

  const payload = {
    title: title.slice(0, 150),
    description: input.description.trim().slice(0, 2000),
    imgur_url: imgurUrl.slice(0, 2000),
    kind: input.kind,
    x_pct: Math.max(0, Math.min(100, num(input.xPct))),
    y_pct: Math.max(0, Math.min(100, num(input.yPct))),
    status: input.status,
  };

  const query = input.id
    ? admin.from("work_points").update(payload).eq("id", input.id)
    : admin.from("work_points").insert({ ...payload, created_by: actor.steamId });

  const { error } = await query.select("id").single();
  if (error) throw queryError(`Не удалось сохранить точку`, error);

  await writeAudit({
    actor: actor.steamId,
    action: input.id ? "point.update" : "point.create",
    entity: "work_points",
    meta: { title: payload.title },
  });
}

export async function deleteWorkPoint(id: string): Promise<void> {
  const actor = await requireSession();

  const { data: existing, error: readError } = await getSupabaseAdmin()
    .from("work_points")
    .select("created_by")
    .eq("id", id)
    .maybeSingle();
  if (readError) throw queryError("Не удалось прочитать точку", readError);
  if (!existing) throw new Error("Точка не найдена");

  const isAuthor = (existing as { created_by?: string | null }).created_by === actor.steamId;
  const asAuthor = isAuthor && (await canAct(actor, "point.create"));
  if (!(await canAct(actor, "point.deleteAny")) && !asAuthor) {
    throw new SessionError("forbidden");
  }

  const { error } = await getSupabaseAdmin().from("work_points").delete().eq("id", id);
  if (error) throw queryError(`Не удалось удалить точку`, error);

  await writeAudit({
    actor: actor.steamId,
    // The moderation vocabulary, not the old one: a reader of the audit log
    // filtering on `point.deleteAny` is asking "who removed a point", which is
    // the only delete this column has ever recorded.
    action: "point.deleteAny",
    entity: "work_points",
    entityId: id,
  });
}

/* -------------------------------------------------------------------------- */
/* Registry, reports, audit                                                    */
/* -------------------------------------------------------------------------- */

/** Probed once per process, like the other schema probes above. */
let hoursTableProbe: boolean | undefined;

/**
 * Whether `member_hours_adjustments` exists yet.
 *
 * Same trade as `declinesTableProbe`: on a database that has not had the
 * migration applied, the registry must still render — with the hours people
 * actually worked and no corrections — rather than fail to open. Once the table
 * exists the probe stops running.
 */
async function hasHoursTable(): Promise<boolean> {
  if (hoursTableProbe === false) return false;
  if (hoursTableProbe === true) return true;

  const { error } = await getSupabaseAdmin()
    .from("member_hours_adjustments")
    .select("id")
    .limit(1);

  hoursTableProbe = !isMissingObject(error);
  if (error && !isMissingObject(error)) {
    throw queryError("Не удалось проверить таблицу корректировок часов", error);
  }
  return hoursTableProbe;
}

/**
 * One member's manual hour corrections, newest first. Staff only.
 *
 * Returning the rows rather than only their sum is the point: a total that
 * silently absorbs a correction is a number nobody can audit, and the registry
 * has to show *why* a member's figure differs from the events they attended.
 */
export async function listHoursAdjustments(steamId: string): Promise<HoursAdjustmentRecord[]> {
  // The corrections that produced somebody's hour total are a moderation record,
  // not a public figure. This had no check at all while the registry rendered the
  // list for anyone who could open the registry — the same screen that could
  // correct hours, which is `registry.editHours`.
  await requirePermission("registry.editHours");
  if (!(await hasHoursTable())) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("member_hours_adjustments")
    .select("id, steam_id, hours, reason, created_by, created_at")
    .eq("steam_id", steamId)
    .order("created_at", { ascending: false });

  if (error) throw queryError("Не удалось прочитать корректировки часов", error);

  const rows = ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => ({
    id: num(row.id),
    steamId: String(row.steam_id),
    hours: num(row.hours),
    reason: (row.reason as string | null) ?? "",
    author: (row.created_by as string | null) ?? null,
    createdAt: String(row.created_at),
  }));

  if (rows.length === 0) return rows;

  const names = await loadMemberNames(rows.map((row) => row.author));
  return rows.map((row) => ({
    ...row,
    author: row.author ? (names.get(row.author) ?? row.author) : null,
  }));
}

/**
 * Credit or claw back hours outside the event roster. Staff only.
 *
 * Signed rather than absolute: the caller may need to take hours *away* as easily
 * as to grant them, and expressing that as a negative number keeps one code path
 * instead of a second "remove hours" function with its own audit and its own bug.
 *
 * The floor check rejects a correction that would push the member below zero. It
 * is a read-then-write and so is not airtight — two simultaneous deductions could
 * both pass it — but a negative balance is not a state this system has anywhere
 * else, and refusing it at the only place a person can see the number is better
 * than storing a figure that renders as "-4 ч" in the registry.
 */
export async function addHoursAdjustment(input: {
  steamId: string;
  hours: number;
  reason: string;
}): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "registry.editHours");

  if (!Number.isFinite(input.hours) || input.hours === 0) {
    throw new Error("Укажите количество часов");
  }

  const hours = Math.round(input.hours * 100) / 100;
  if (Math.abs(hours) > 1440) {
    throw new Error("За одну правку можно поставить не больше 1440 часов");
  }

  if (!(await hasHoursTable())) {
    throw new Error(
      "Правка часов недоступна: в базе нет таблицы member_hours_adjustments. Примените supabase/migrations/002_portal.sql",
    );
  }

  const { data: member, error: memberError } = await getSupabaseAdmin()
    .from("profiles")
    .select("steam_id, status")
    .eq("steam_id", input.steamId)
    .maybeSingle();

  if (memberError) throw queryError("Не удалось найти участника", memberError);
  if (!member) throw new Error("Участник не найден");

  if (hours < 0) {
    const current = await getMemberHoursTotal(input.steamId);
    if (Math.abs(hours) > current) {
      throw new Error(
        `Нельзя снять больше, чем у участника есть: ${current} ч. Удалите лишние часы через правки`,
      );
    }
  }

  const { error } = await getSupabaseAdmin().from("member_hours_adjustments").insert({
    steam_id: input.steamId,
    hours,
    reason: input.reason.trim().slice(0, 500),
    created_by: actor.steamId,
  });

  if (error) throw queryError("Не удалось сохранить правку часов", error);

  await writeAudit({
    actor: actor.steamId,
    action: "hours.adjust",
    entity: "member_hours_adjustments",
    entityId: input.steamId,
    meta: { hours, reason: input.reason.trim().slice(0, 500) },
  });
}

/** Withdraw a correction entirely. Staff only. */
export async function deleteHoursAdjustment(id: number): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "registry.editHours");

  if (!(await hasHoursTable())) return;

  const { data: existing, error: readError } = await getSupabaseAdmin()
    .from("member_hours_adjustments")
    .select("id, steam_id, hours")
    .eq("id", id)
    .maybeSingle();

  if (readError) throw queryError("Не удалось найти правку часов", readError);
  if (!existing) throw new Error("Правка не найдена");

  const { error } = await getSupabaseAdmin()
    .from("member_hours_adjustments")
    .delete()
    .eq("id", id);

  if (error) throw queryError("Не удалось удалить правку часов", error);

  await writeAudit({
    actor: actor.steamId,
    action: "hours.adjust.delete",
    entity: "member_hours_adjustments",
    entityId: id,
    meta: { steamId: (existing as { steam_id: string }).steam_id, hours: num((existing as { hours: unknown }).hours) },
  });
}

/**
 * Worked hours for one member: events plus corrections.
 *
 * Split out because `addHoursAdjustment` needs the same total as the registry
 * shows, and computing it twice in two places is how the floor check and the
 * displayed figure drift apart.
 */
async function getMemberHoursTotal(steamId: string): Promise<number> {
  const { data, error } = await getSupabaseAdmin()
    .from("member_hours_totals")
    .select("total_hours")
    .eq("steam_id", steamId)
    .maybeSingle();

  if (error) throw queryError("Не удалось посчитать часы участника", error);

  const eventHours = data ? num((data as { total_hours: unknown }).total_hours) : 0;

  if (!(await hasHoursTable())) return eventHours;

  const { data: rows, error: sumError } = await getSupabaseAdmin()
    .from("member_hours_adjustments")
    .select("hours")
    .eq("steam_id", steamId);

  if (sumError) throw queryError("Не удалось посчитать правки часов", sumError);

  const adjusted = ((rows ?? []) as unknown as Array<{ hours: unknown }>).reduce(
    (sum, row) => sum + num(row.hours),
    0,
  );

  return Math.round((eventHours + adjusted) * 100) / 100;
}

/**
 * The member registry.
 *
 * Any approved member may call this, because the "кто в партии" list is not
 * secret. What is secret is contact detail, and that is filtered here rather than
 * in the component: a non-staff caller receives `contactsPublic: false` rows with
 * the contact fields stripped to null, so no client-side check can leak them.
 */
export async function listRegistry(): Promise<RegistryEntry[]> {
  const session = await requireSession();
  await assertCan(session, "registry.view");

  // Whether the caller sees contact detail. This used to be keyed off
  // `report.viewAll`, which is a different question — reading somebody's hours is
  // not what entitles you to their phone number — so a custom role built for
  // "secretary" had to be handed report access to see an address book.
  // `profile.editAny` is the permission that is actually about other people's
  // details, contact fields included.
  const staff = await canAct(session, "profile.editAny");
  const admin = getSupabaseAdmin();

  // `profiles` is the base of the registry and `member_hours_totals` is joined onto
  // it here by hand, rather than reading the view and then fetching matching
  // profiles. The view is driven by `event_attendance`, so it has no row at all for
  // a member who has never worked a shift. Reading profiles first is what keeps
  // those members in the list: the earlier version only fell back when the view was
  // *entirely* empty, so a party that had worked one event showed everybody except
  // the volunteers who had not made it to that one.
  // No `role`: it is the cache column and can only name the highest role. The
  // badges on a registry card come from the assignment rows.
  const { data: people, error: peopleError } = await admin
    .from("profiles")
    .select("steam_id, display_name, persona, status, about, telegram, discord, phone, contacts_public, created_at, approved_at")
    .order("created_at", { ascending: true });

  if (peopleError) throw queryError(`Failed to read profiles`, peopleError);

  const { data: totals, error: totalsError } = await admin
    .from("member_hours_totals")
    .select("steam_id, total_hours, events_attended, events_absent");

  if (totalsError) throw queryError(`Failed to read hours totals`, totalsError);

  // Manual corrections, summed onto the event total. One query for the whole
  // registry rather than per member: N+1 here would be a round trip per card,
  // and the table is the size of the party, not of the events.
  //
  // Absent table -> no corrections, and the registry still renders. That is the
  // whole point of the probe: a missing migration degrades the feature instead
  // of taking the roster down.
  const adjustmentById = new Map<string, number>();
  if (await hasHoursTable()) {
    const { data: adjustments, error: adjustmentsError } = await admin
      .from("member_hours_adjustments")
      .select("steam_id, hours");

    if (adjustmentsError) throw queryError("Не удалось прочитать правки часов", adjustmentsError);

    for (const row of (adjustments ?? []) as unknown as Array<Record<string, unknown>>) {
      const id = String(row.steam_id);
      adjustmentById.set(id, (adjustmentById.get(id) ?? 0) + num(row.hours));
    }
  }

  const hoursById = new Map(
    ((totals ?? []) as unknown as Array<Record<string, unknown>>).map((row) => {
      const id = String(row.steam_id);
      const eventHours = num(row.total_hours);
      const adjusted = adjustmentById.get(id) ?? 0;
      return [
        id,
        {
          // Rounded because both halves are `numeric` and `0.1 + 0.2` in a
          // ledger column is a rounding error waiting to be read as a discrepancy
          // by whoever trusts the number.
          totalHours: Math.round((eventHours + adjusted) * 100) / 100,
          eventsAttended: num(row.events_attended),
          eventsAbsent: num(row.events_absent),
        },
      ] as const;
    }),
  );

  // A member whose only hours came from corrections has no row in the view at
  // all, because the view is driven by `event_attendance`. Fold the adjustment
  // map over the profiles afterwards so those members are not dropped to zero.
  for (const [id, adjusted] of adjustmentById) {
    if (hoursById.has(id)) continue;
    hoursById.set(id, {
      totalHours: Math.round(adjusted * 100) / 100,
      eventsAttended: 0,
      eventsAbsent: 0,
    });
  }

  const peopleRows = (people ?? []) as unknown as Array<Record<string, unknown>>;
  const roleSets = await readRoleSets(peopleRows.map((row) => String(row.steam_id)));

  const entries = peopleRows.map((row) =>
    toRegistryEntry(
      row,
      { staff, viewerId: session.steamId },
      hoursById.get(String(row.steam_id)) ?? { totalHours: 0, eventsAttended: 0, eventsAbsent: 0 },
      roleSets.get(String(row.steam_id)) ?? [],
    ),
  );

  // Busiest first, with never-worked members kept at the bottom rather than
  // dropped, and ties broken by join date so the order is stable between reloads.
  return entries.sort((a, b) => b.totalHours - a.totalHours || a.createdAt.localeCompare(b.createdAt));
}
export async function getMyHours(): Promise<MyHours> {
  const session = await requireSession();
  const admin = getSupabaseAdmin();

  const { data, error } = await admin
    .from("event_attendance")
    .select("status, hours, event_id")
    .eq("steam_id", session.steamId);

  if (error) throw queryError(`Не удалось прочитать свои часы`, error);

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;

  const { data: events } = await admin
    .from("party_events")
    .select("id, starts_at, status")
    .eq("is_published", true)
    .eq("status", "open");

  const openIds = new Set(
    ((events ?? []) as unknown as Array<Record<string, unknown>>).map((row) => String(row.id)),
  );

  return {
    totalHours: rows
      .filter((row) => row.status === "attended")
      .reduce((sum, row) => sum + num(row.hours), 0),
    eventsAttended: rows.filter((row) => row.status === "attended").length,
    eventsAbsent: rows.filter((row) => row.status === "absent").length,
    upcomingCount: rows.filter((row) => openIds.has(String(row.event_id))).length,
  };
}

/** The audit trail. Staff only. */
export async function listAudit(limit = 50): Promise<AuditEntry[]> {
  await requirePermission("report.viewAll");

  const { data, error } = await getSupabaseAdmin()
    .from("audit_log")
    .select("id, actor, action, entity, entity_id, meta, created_at")
    .order("created_at", { ascending: false })
    .limit(Math.max(1, Math.min(200, limit)));

  if (error) throw queryError(`Не удалось прочитать журнал`, error);

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  const names = await loadMemberNames(rows.map((row) => String(row.actor)));

  return rows.map((row) => {
    const actor = (row.actor as string | null) ?? null;
    const meta = (row.meta ?? {}) as unknown as Record<string, unknown>;
    return {
      id: String(row.id),
      actor,
      actorName: actor ? (names.get(actor) ?? actor) : "Система",
      action: String(row.action),
      entity: String(row.entity),
      entityId: (row.entity_id as string | null) ?? null,
      meta,
      createdAt: String(row.created_at),
    };
  });
}

/**
 * The public event list: what an anonymous visitor to the homepage sees.
 *
 * No session, no `requireSession`, no role check — deliberately. This is the one
 * exported reader in this file that is *meant* to be reachable without an
 * account, so the only thing standing between the internet and every draft,
 * headcount cap and closure note is the filter below. It selects an explicit
 * column list rather than `*`, so a column added later for portal use is not
 * published by being forgotten here.
 *
 * The two visibility conditions are independent and both are required:
 *   - `is_published`: an internal event that was never announced;
 *   - `status <> draft`: publication and status are separate switches, so a draft
 *     that someone ticked "publish" on would otherwise be on the public site.
 *
 * `finished` events are returned, but through `past` rather than `upcoming`: an
 * outsider still wants to see that the party cleans the park on Saturdays, and that
 * is a recruiting argument rather than an internal note. What they must not get is
 * last month's meeting presented under a heading that says "come to our meetings".
 * So the split is explicit — future and running events are an invitation, past ones
 * are an archive, and the page decides where each belongs.
 *
 * `created_by` is resolved through the member-name helper, which reads
 * `display_name` first. A character's chosen name is what the party is known by,
 * and a page mixing "Elena Smirnova" with `@elenka228` looks broken.
 */
export async function listPublicEvents(
  group: "upcoming" | "past",
  limit = 4,
): Promise<PublicEvent[]> {
  const capped = Math.max(1, Math.min(20, limit));
  const admin = getSupabaseAdmin();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();

  // The public list is a deliberately narrow column set, so the author is added to
  // it separately rather than by trimming the internal list down to it.
  const columns = (await hasCreatedByColumn(admin))
    ? `${PUBLIC_EVENT_COLUMNS}, ${CREATED_BY}`
    : PUBLIC_EVENT_COLUMNS;

  let query = admin
    .from("party_events")
    .select(columns)
    .eq("is_published", true)
    .neq("status", "draft");

  if (await hasDeletedAtColumn(admin)) query = query.is("deleted_at", null);

  if (group === "upcoming") {
    // Anything still ahead of us, including something already under way. The
    // `ends_at is null` arm covers events with no end time, which are upcoming as
    // long as they have not started. PostgREST needs the ISO instant quoted, and
    // the colons inside it are encoded by the client, so the string is safe.
    query = query
      .or(`ends_at.gt.${nowIso},and(ends_at.is.null,starts_at.gt.${nowIso})`)
      .order("starts_at", { ascending: true });
  } else {
    // Descending on purpose: the most recent meeting is the interesting one, and
    // the old code's ascending order meant a page titled "nearest events" filled up
    // with the four oldest things the party has ever done.
    query = query.lt("starts_at", nowIso).order("starts_at", { ascending: false });
  }

  const { data, error } = await query.limit(capped);
  if (error) throw queryError("Failed to read public events", error);

  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];

  // Reclassify in JS rather than trusting the filter. The two buckets the query can
  // return do not line up exactly with the two states a human cares about: an event
  // that started an hour ago and ends in three is `live`, and it arrived in the
  // `upcoming` query but must not also show up in the archive below it.
  const isWanted = (state: EventState) =>
    group === "upcoming" ? state !== "past" : state === "past";

  const candidates = rows
    .map((row) => {
      const status = (row.status ?? "draft") as EventStatus;
      const startsAt = String(row.starts_at ?? "");
      const endsAt = (row.ends_at as string | null) ?? null;

      return {
        publicState: eventState(status, startsAt, endsAt, now),
        event: {
          id: String(row.id),
          title: String(row.title ?? ""),
          description: String(row.description ?? ""),
          location: String(row.location ?? ""),
          startsAt,
          endsAt,
          // Resolved below, once every author id is known.
          createdByName: null,
          trackHours: row.track_hours !== false,
          status,
          publicState: eventState(status, startsAt, endsAt, now),
        } satisfies PublicEvent,
        createdBy: (row.created_by as string | null) ?? null,
      };
    })
    .filter((entry) => isWanted(entry.publicState))
    .slice(0, capped);

  const names = await loadMemberNames(candidates.map((entry) => entry.createdBy ?? ""));

  return candidates.map(({ createdBy, event }) => ({
    ...event,
    // `loadMemberNames` skips empty ids, so a null author yields an empty map
    // entry rather than an empty name here.
    createdByName: createdBy ? (names.get(createdBy) ?? null) : null,
  }));
}

/* -------------------------------------------------------------------------- */
/* Custom roles                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether 003_custom_roles.sql has been applied.
 *
 * Memoised the same way `hasHoursTable` is, for the same reason: until the
 * migration is run the role manager has nothing to read, and the correct answer
 * is "no roles exist yet", not an error page. A console warning marks the window
 * so it cannot pass unnoticed.
 */
let roleTableProbe: boolean | undefined;

async function hasRoleTables(): Promise<boolean> {
  if (roleTableProbe !== undefined) return roleTableProbe;

  const { error } = await getSupabaseAdmin().from("custom_roles").select("id").limit(1);

  if (error && !isMissingObject(error)) {
    throw queryError("Не удалось проверить таблицу ролей", error);
  }

  roleTableProbe = !isMissingObject(error);

  if (!roleTableProbe) {
    console.error(
      "[portal] custom_roles is not present — the role manager will be empty. Apply supabase/migrations/003_custom_roles.sql.",
    );
  }

  return roleTableProbe;
}

interface CustomRoleRow {
  id: number;
  key: string;
  name: string;
  description: string;
  created_at: string;
  // Element types carry no `null`: `embeddedList` is what strips it, and having
  // it in both places makes every consumer of the result null-check again.
  custom_role_permissions: Array<{ action: string }> | { action: string } | null;
  /** PostgREST aggregate over the grant relation, when requested. */
  profile_role_grants?: Array<{ count: number }> | { count: number } | null;
}

/**
 * Read one embedded relation that PostgREST may return as an object or an array.
 *
 * The two shapes are the same data and guessing wrong reads as "no permissions",
 * which in this file would mean quietly hiding every permission a role grants.
 */
function embeddedList<T>(value: T | T[] | null | undefined): T[] {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter((item): item is T => item != null) : [value];
}

/**
 * Reject an action list the caller is not allowed to hand out.
 *
 * Two independent rules, both server-side. `isGrantable` is the floor: unknown or
 * non-delegable actions are dropped no matter who asks, so a hand-written insert
 * or a future bug cannot smuggle `profile.setRole` into a role. `canGrantAll` is
 * the ceiling: a role may only contain what its author already holds, so an admin
 * can build anything up to admin and no further.
 *
 * Throwing rather than filtering-and-saving is deliberate. Silently dropping the
 * one action the editor would not have offered is a worse outcome than an
 * error: the person clicks "save", sees success, and later wonders why the role
 * does not do what they built it to do.
 */
async function assertActionsGrantable(actor: ProfileDTO, actions: readonly string[]): Promise<Action[]> {
  const valid: Action[] = [];
  const rejected: string[] = [];

  for (const action of actions) {
    if (isGrantable(action)) valid.push(action);
    else rejected.push(action);
  }

  if (rejected.length > 0) {
    throw new Error(`Недопустимые права в роли: ${rejected.join(", ")}`);
  }

  if (!(await canGrantAll(actor, valid))) {
    throw new Error("Нельзя выдать права, которых нет у вас самих");
  }

  return Array.from(new Set(valid));
}

/** Every custom role with its actions and holder count. */
export async function listCustomRoles(): Promise<CustomRoleRecord[]> {
  const actor = await requireSession();
  await assertCan(actor, "profile.grantRole");

  if (!(await hasRoleTables())) return [];

  const { data, error } = await getSupabaseAdmin()
    .from("custom_roles")
    .select("id, key, name, description, created_at, custom_role_permissions ( action ), profile_role_grants ( count )")
    .order("name", { ascending: true });

  if (error) throw queryError("Не удалось загрузить роли", error);

  return ((data ?? []) as unknown as CustomRoleRow[]).map((row) => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    createdAt: row.created_at,
    actions: embeddedList(row.custom_role_permissions)
      .map((item) => item.action)
      .filter(isGrantable),
    holderCount: embeddedList(row.profile_role_grants).reduce((sum, item) => sum + (item.count ?? 0), 0),
  }));
}

/**
 * Create a role.
 *
 * `key` is derived from the name when the caller does not supply one, and
 * de-duplicated with a numeric suffix, because the CHECK constraint on `key`
 * rejects anything outside `^[a-z0-9_]{2,40}$` and a Russian name transliterates
 * to nothing useful on its own.
 */
export async function createCustomRole(input: {
  name: string;
  description: string;
  actions: readonly string[];
}): Promise<number> {
  const actor = await requireSession();
  await assertCan(actor, "profile.grantRole");

  if (!(await hasRoleTables())) {
    throw new Error("Таблицы ролей ещё не созданы. Примените 003_custom_roles.sql.");
  }

  const actions = await assertActionsGrantable(actor, input.actions);

  if (input.actions.length === 0) throw new Error("Роль без прав бесполезна");
  if (input.name.trim().length < 2) throw new Error("Слишком короткое название");

  const { data: clash } = await getSupabaseAdmin()
    .from("custom_roles")
    .select("key")
    .like("key", `${slugify(input.name)}%`);

  const taken = new Set(((clash ?? []) as Array<{ key: string }>).map((row) => row.key));
  const base = slugify(input.name);
  let key = base;
  for (let suffix = 2; taken.has(key); suffix++) key = `${base}_${suffix}`;

  const { data, error } = await getSupabaseAdmin()
    .from("custom_roles")
    .insert({ key, name: input.name.trim(), description: input.description.trim() })
    .select("id")
    .single();

  if (error) throw queryError("Не удалось создать роль", error);

  const roleId = (data as { id: number }).id;

  if (actions.length > 0) {
    const { error: permError } = await getSupabaseAdmin()
      .from("custom_role_permissions")
      .insert(actions.map((action) => ({ role_id: roleId, action })));

    if (permError) {
      // Leave nothing half-made: a role row with no permissions would appear in
      // the manager and grant nobody anything, which is the kind of invisible
      // state that gets discovered months later.
      await getSupabaseAdmin().from("custom_roles").delete().eq("id", roleId);
      throw queryError("Не удалось сохранить права роли", permError);
    }
  }

  await writeAudit({
    actor: actor.steamId,
    action: "role.create",
    entity: "custom_roles",
    entityId: roleId,
    meta: { key, name: input.name, actions },
  });

  return roleId;
}

/** Rename a role or replace its permission set. `key` is deliberately immutable. */
export async function updateCustomRole(input: {
  roleId: number;
  name: string;
  description: string;
  actions: readonly string[];
}): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.grantRole");

  const actions = await assertActionsGrantable(actor, input.actions);
  if (input.name.trim().length < 2) throw new Error("Слишком короткое название");

  const { error } = await getSupabaseAdmin()
    .from("custom_roles")
    .update({ name: input.name.trim(), description: input.description.trim() })
    .eq("id", input.roleId);

  if (error) throw queryError("Не удалось изменить роль", error);

  // Replace rather than merge. A role whose permissions are edited down to
  // nothing while somebody holds it is a latent escalation: the permissions come
  // back the next time the row is touched, for whoever still holds it.
  const { error: deleteError } = await getSupabaseAdmin()
    .from("custom_role_permissions")
    .delete()
    .eq("role_id", input.roleId);

  if (deleteError) throw queryError("Не удалось обновить права роли", deleteError);

  if (actions.length > 0) {
    const { error: insertError } = await getSupabaseAdmin()
      .from("custom_role_permissions")
      .insert(actions.map((action) => ({ role_id: input.roleId, action })));

    if (insertError) throw queryError("Не удалось обновить права роли", insertError);
  }

  await writeAudit({
    actor: actor.steamId,
    action: "role.update",
    entity: "custom_roles",
    entityId: input.roleId,
    meta: { name: input.name, actions },
  });
}

/**
 * Delete a role. Its grants go with it.
 *
 * The UI warns with the holder count first. That is a courtesy, not the
 * mechanism — the cascade is what makes the deletion consistent, and a role that
 * outlives its permissions is worse than no role at all.
 */
export async function deleteCustomRole(roleId: number): Promise<void> {
  const actor = await requireSession();
  await assertCan(actor, "profile.grantRole");

  const { data, error } = await getSupabaseAdmin()
    .from("custom_roles")
    .delete()
    .eq("id", roleId)
    .select("key");

  if (error) throw queryError("Не удалось удалить роль", error);
  if (!data || (data as unknown[]).length === 0) throw new Error("Роль не найдена");

  await writeAudit({
    actor: actor.steamId,
    action: "role.delete",
    entity: "custom_roles",
    entityId: roleId,
    // No per-holder rows on purpose: the grants are gone, and the audit that
    // matters is the one that records who decided to remove them.
    meta: { key: (data as Array<{ key: string }>)[0].key },
  });
}

/** Who holds what. `roleId` narrows it to one role; omit for the whole picture. */
export async function listRoleGrants(roleId?: number): Promise<RoleGrantRecord[]> {
  const actor = await requireSession();
  await assertCan(actor, "profile.grantRole");

  if (!(await hasRoleTables())) return [];

  let query = getSupabaseAdmin()
    .from("profile_role_grants")
    .select(
      // Both the FK constraint name *and* an alias are required. The constraint
      // name alone leaves PostgREST resolving both embeds to the same internal
      // relation and it answers 42712 "table name specified more than once"; the
      // alias alone leaves it unable to choose between the two foreign keys and it
      // answers PGRST201. Together they work. Verified against the live database.
      "steam_id,granted_by,granted_at,custom_roles(id,key,name),holder:profiles!profile_role_grants_steam_id_fkey(display_name),granter:profiles!profile_role_grants_granted_by_fkey(display_name)",
    );

  if (roleId !== undefined) query = query.eq("role_id", roleId);

  const { data, error } = await query.order("granted_at", { ascending: false });

  if (error) throw queryError("Не удалось загрузить назначения ролей", error);

  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((row) => {
    const role = row.custom_roles as { id: number; key: string; name: string } | null;

    // PostgREST returns a to-one embed as an object, not an array, even for the
    // aliased ones. `embeddedList` normalises the two, so the cast is the union
    // rather than a lie about which one arrives.
    const holder = row.holder as { display_name: string } | { display_name: string }[] | null;
    const granter = row.granter as { display_name: string } | { display_name: string }[] | null;

    return {
      steamId: row.steam_id as string,
      // Keyed by the select aliases, not by the relation name.
      displayName: embeddedList(holder)[0]?.display_name ?? (row.steam_id as string),
      roleId: role?.id ?? (roleId ?? 0),
      roleKey: role?.key ?? "",
      roleName: role?.name ?? "",
      grantedBy: (row.granted_by as string | null) ?? null,
      grantedByName: embeddedList(granter)[0]?.display_name ?? null,
      grantedAt: row.granted_at as string,
    };
  });
}

/**
 * Grant one role to many members at once.
 *
 * The whole batch is one audit row, not one per member. Both are defensible; this
 * one is chosen because the interesting event is the decision, and forty rows of
 * `role.grant` differing only in `steam_id` makes the audit log harder to read
 * than the thing it records. The affected members are listed in `meta.steamIds`.
 *
 * Members who already hold the role come back in `skipped` rather than failing:
 * the primary key would reject them, and a batch of twenty people where three
 * were already set should not have to be retried to find that out.
 */
export async function grantCustomRole(input: {
  roleId: number;
  steamIds: readonly string[];
}): Promise<RoleGrantResult> {
  const actor = await requireSession();
  await assertCan(actor, "profile.grantRole");

  if (!(await hasRoleTables())) {
    throw new Error("Таблицы ролей ещё не созданы. Примените 003_custom_roles.sql.");
  }

  const unique = Array.from(new Set(input.steamIds.map((id) => id.trim()).filter(Boolean)));
  if (unique.length === 0) return { applied: [], skipped: [] };

  const { data: role } = await getSupabaseAdmin()
    .from("custom_roles")
    .select("id, key, name")
    .eq("id", input.roleId)
    .maybeSingle();

  if (!role) throw new Error("Роль не найдена");

  const { data: existing } = await getSupabaseAdmin()
    .from("profile_role_grants")
    .select("steam_id")
    .eq("role_id", input.roleId)
    .in("steam_id", unique);

  const already = new Set(((existing ?? []) as Array<{ steam_id: string }>).map((row) => row.steam_id));
  const toApply = unique.filter((id) => !already.has(id));

  if (toApply.length > 0) {
    const { error } = await getSupabaseAdmin().from("profile_role_grants").insert(
      toApply.map((steamId) => ({
        steam_id: steamId,
        role_id: input.roleId,
        granted_by: actor.steamId,
      })),
    );

    // A FK violation here means one of the ids is not a member; report it by
    // name rather than as a raw constraint message.
    if (error) throw queryError("Не удалось назначить роль: проверьте, что все участники существуют", error);
  }

  const result = { applied: toApply, skipped: unique.filter((id) => already.has(id)) };

  if (result.applied.length > 0) {
    await writeAudit({
      actor: actor.steamId,
      action: "role.grant",
      entity: "profile_role_grants",
      entityId: input.roleId,
      meta: { roleKey: (role as { key: string }).key, steamIds: result.applied, count: result.applied.length },
    });
  }

  return result;
}

/** Take one role away from many members. Same batch semantics as `grantCustomRole`. */
export async function revokeCustomRole(input: {
  roleId: number;
  steamIds: readonly string[];
}): Promise<RoleGrantResult> {
  const actor = await requireSession();
  await assertCan(actor, "profile.grantRole");

  const unique = Array.from(new Set(input.steamIds.map((id) => id.trim()).filter(Boolean)));
  if (unique.length === 0) return { applied: [], skipped: [] };

  const { data: deleted, error } = await getSupabaseAdmin()
    .from("profile_role_grants")
    .delete()
    .eq("role_id", input.roleId)
    .in("steam_id", unique)
    .select("steam_id");

  if (error) throw queryError("Не удалось снять роль", error);

  const applied = ((deleted ?? []) as Array<{ steam_id: string }>).map((row) => row.steam_id);
  const removed = new Set(applied);
  const result = { applied, skipped: unique.filter((id) => !removed.has(id)) };

  if (result.applied.length > 0) {
    const { data: role } = await getSupabaseAdmin()
      .from("custom_roles")
      .select("key")
      .eq("id", input.roleId)
      .maybeSingle();

    await writeAudit({
      actor: actor.steamId,
      action: "role.revoke",
      entity: "profile_role_grants",
      entityId: input.roleId,
      meta: {
        roleKey: (role as { key: string } | null)?.key ?? null,
        steamIds: result.applied,
        count: result.applied.length,
      },
    });
  }

  return result;
}

/**
 * ASCII slug for the storage key.
 *
 * Transliteration covers the Russian alphabet so a role named in Russian gets a
 * stable, readable key; anything unrecognised is dropped rather than encoded, and
 * the caller de-duplicates against a numeric suffix. A role whose name is entirely
 * untransliterable ends up keyed `role_2`, which is fine: the key is never shown.
 */
function slugify(name: string): string {
  const table: Record<string, string> = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z",
    и: "i", й: "y", к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r",
    с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch",
    ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };

  const slug = name
    .toLowerCase()
    .split("")
    .map((char) => (char in table ? table[char] : char))
    .join("")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);

  return slug.length >= 2 ? slug : "role";
}
