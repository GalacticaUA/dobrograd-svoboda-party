"use server";

/**
 * Portal Server Actions.
 *
 * Same contract as app/lib/auth/actions.ts, and the same reasoning: a Server
 * Action is an HTTP POST endpoint that anyone can replay from curl, so every
 * action here re-derives the caller from the signed session cookie and hands the
 * work to the DAL, which applies the same `can()` the UI used to decide which
 * buttons to draw.
 *
 * The UI check is therefore a convenience for the user, never the boundary. If
 * the two ever disagree, the server wins and the action returns "недостаточно
 * прав" — the visible symptom of a bug, not a security hole.
 *
 * These actions also serve as the *read* path. The portal renders inside a modal
 * that the user opens on demand, so loading all nine tabs' data during the page
 * render would ship a payload nobody asked for yet. Each tab fetches itself on
 * mount instead, and re-fetches after its own mutations.
 */

import type { ActionResult } from "@/lib/auth/actions";
import { SessionError } from "@/lib/auth/dal";
import { listApplications } from "@/lib/auth/dal";
import {
  addHoursAdjustment,
  createAppeal,
  createCustomRole,
  createPoll,
  deleteAppeal,
  deleteCustomRole,
  deleteEvent,
  deleteHoursAdjustment,
  deletePoll,
  deleteWorkPoint,
  getAccountProfile,
  getAvailabilityMatrix,
  addMemberRole,
  getMyHours,
  getOwnAvailability,
  grantCustomRole,
  listAppeals,
  listAudit,
  listCustomRoles,
  listDeletedEvents,
  listEvents,
  listHoursAdjustments,
  listPolls,
  listRegistry,
  listRoleGrants,
  listWorkPoints,
  recordAttendance,
  removeMember,
  removeMemberRole,
  replaceOwnAvailability,
  restoreEvent,
  revokeCustomRole,
  setAppealReply,
  setAppealStatus,
  setMemberRoles,
  setMemberApproval,
  setOwnRsvp,
  setPollStatus,
  updateAccountProfile,
  updateCustomRole,
  updateMemberProfile,
  upsertEvent,
  upsertWorkPoint,
  voteInPoll,
} from "@/lib/portal/dal";
import { countTopStanding, readRoleSet } from "@/lib/auth/roles";
import type {
  AccountProfile,
  AccountUpdateInput,
  AppealRecord,
  AppealStatus,
  AttendanceInput,
  AuditEntry,
  AvailabilityMatrixRow,
  AvailabilitySlot,
  CustomRoleRecord,
  EventRecord,
  EventUpsertInput,
  EventWithAttendance,
  HoursAdjustmentRecord,
  MyHours,
  PollRecord,
  RegistryEntry,
  RoleGrantRecord,
  RoleGrantResult,
  RsvpInput,
  WorkPointInput,
  WorkPointRecord,
} from "@/lib/portal/types";
import type { ApprovalStatus, ApplicationRecord } from "@/types/auth";
import type { Role } from "@/types/party";

/**
 * Turn a thrown error into a result the UI can show in a toast.
 *
 * A SessionError is the DAL saying "your session is not good enough"; anything
 * else is a bug or an outage, and its message is deliberately not forwarded,
 * because a raw Supabase error names tables and columns.
 */
async function fail(error: unknown): Promise<ActionResult<never>> {
  if (error instanceof SessionError) {
    return { ok: false, error: "Недостаточно прав или сессия истекла.", reason: error.reason };
  }
  console.error("[portal] action failed:", error);
  const message = error instanceof Error ? error.message : null;
  return {
    ok: false,
    error: message ?? "Внутренняя ошибка. Попробуйте позже.",
  };
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                        */
/* -------------------------------------------------------------------------- */

export async function loadAccount(): Promise<ActionResult<AccountProfile>> {
  try {
    return { ok: true, data: await getAccountProfile() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadAvailability(): Promise<ActionResult<AvailabilitySlot[]>> {
  try {
    return { ok: true, data: await getOwnAvailability() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadAvailabilityMatrix(): Promise<ActionResult<AvailabilityMatrixRow[]>> {
  try {
    return { ok: true, data: await getAvailabilityMatrix() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadEvents(): Promise<ActionResult<EventWithAttendance[]>> {
  try {
    return { ok: true, data: await listEvents() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadDeletedEvents(): Promise<ActionResult<EventWithAttendance[]>> {
  try {
    return { ok: true, data: await listDeletedEvents() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadAppeals(): Promise<ActionResult<AppealRecord[]>> {
  try {
    return { ok: true, data: await listAppeals() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadPolls(): Promise<ActionResult<PollRecord[]>> {
  try {
    return { ok: true, data: await listPolls() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadWorkPoints(): Promise<ActionResult<WorkPointRecord[]>> {
  try {
    return { ok: true, data: await listWorkPoints() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadRegistry(): Promise<ActionResult<RegistryEntry[]>> {
  try {
    return { ok: true, data: await listRegistry() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadMyHours(): Promise<ActionResult<MyHours>> {
  try {
    return { ok: true, data: await getMyHours() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadAudit(): Promise<ActionResult<AuditEntry[]>> {
  try {
    return { ok: true, data: await listAudit() };
  } catch (error) {
    return fail(error);
  }
}

/**
 * The join queue, for the management tab.
 *
 * Reuses `listApplications()` from the auth DAL rather than re-reading the table
 * here, so there is still exactly one staff-gated code path to that applicant PII.
 */
export async function loadApplications(): Promise<ActionResult<ApplicationRecord[]>> {
  try {
    return { ok: true, data: await listApplications() };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Account                                                                      */
/* -------------------------------------------------------------------------- */

export async function saveAccount(
  input: AccountUpdateInput,
): Promise<ActionResult<AccountProfile>> {
  try {
    return { ok: true, data: await updateAccountProfile(input) };
  } catch (error) {
    return fail(error);
  }
}

/**
 * Replace somebody's whole role set. The action behind the badge stack's
 * "apply" and behind the role editor's two columns.
 *
 * Returns the roles the server settled on rather than nothing, so the client can
 * paint what the database now believes. That matters for the leader: adding it
 * transfers the title, and the previous holder's badge disappears in a different
 * row of a different table. The caller needs the truth, not an echo of its own
 * optimistic guess.
 */
export async function saveMemberRoles(input: {
  steamId: string;
  roles: readonly Role[];
}): Promise<ActionResult<Role[]>> {
  try {
    await setMemberRoles({ steamId: input.steamId, roles: input.roles });
    return { ok: true, data: await readRoleSet(input.steamId) };
  } catch (error) {
    return fail(error);
  }
}

/** The `+ Добавить роль` button. */
export async function grantMemberRole(
  steamId: string,
  role: Role,
): Promise<ActionResult<Role[]>> {
  try {
    await addMemberRole(steamId, role);
    return { ok: true, data: await readRoleSet(steamId) };
  } catch (error) {
    return fail(error);
  }
}

/** The `×` on a badge. */
export async function revokeMemberRole(
  steamId: string,
  role: Role,
): Promise<ActionResult<Role[]>> {
  try {
    await removeMemberRole(steamId, role);
    return { ok: true, data: await readRoleSet(steamId) };
  } catch (error) {
    return fail(error);
  }
}

/** Approve, suspend or expel. Separate from the roles on purpose — see the DAL. */
export async function saveMemberStatus(
  steamId: string,
  status: ApprovalStatus,
): Promise<ActionResult> {
  try {
    await setMemberApproval(steamId, status);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** How many approved people can appoint, for the UI's impossible options. */
export async function loadAppointerCount(): Promise<ActionResult<number>> {
  try {
    return { ok: true, data: await countTopStanding() };
  } catch (error) {
    return fail(error);
  }
}

/** Staff fix somebody's character name. See `updateMemberProfile`. */
export async function saveMemberProfile(input: {
  steamId: string;
  displayName: string;
  about: string;
}): Promise<ActionResult> {
  try {
    await updateMemberProfile(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** Expel a member. Reversible only by re-approving them from the queue. */
export async function saveMemberRemoval(input: {
  steamId: string;
  reason: string;
}): Promise<ActionResult> {
  try {
    await removeMember(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** One member's hour corrections. */
export async function loadMemberHours(
  steamId: string,
): Promise<ActionResult<HoursAdjustmentRecord[]>> {
  try {
    return { ok: true, data: await listHoursAdjustments(steamId) };
  } catch (error) {
    return fail(error);
  }
}

/** Credit or claw back hours outside the event roster. */
export async function saveHoursAdjustment(input: {
  steamId: string;
  hours: number;
  reason: string;
}): Promise<ActionResult> {
  try {
    await addHoursAdjustment(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/** Withdraw a correction. */
export async function dropHoursAdjustment(id: number): Promise<ActionResult> {
  try {
    await deleteHoursAdjustment(id);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Availability                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Save the whole week. `slots` is a plain array of numbers, which serialises
 * cleanly; the DAL validates ranges and rejects impossible intervals.
 */
export async function saveAvailability(
  slots: Array<{ weekday: number; fromMin: number; toMin: number }>,
): Promise<ActionResult<AvailabilitySlot[]>> {
  try {
    return { ok: true, data: await replaceOwnAvailability(slots) };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Schedule                                                                     */
/* -------------------------------------------------------------------------- */

export async function saveEvent(input: EventUpsertInput): Promise<ActionResult<EventRecord>> {
  try {
    return { ok: true, data: await upsertEvent(input) };
  } catch (error) {
    return fail(error);
  }
}

export async function setRsvp(input: RsvpInput): Promise<ActionResult> {
  try {
    await setOwnRsvp(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function saveAttendance(input: {
  eventId: string;
  rows: AttendanceInput[];
  totalHours?: number | null;
}): Promise<ActionResult> {
  try {
    await recordAttendance(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function removeEvent(eventId: string): Promise<ActionResult> {
  try {
    await deleteEvent(eventId);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function restoreEventById(eventId: string): Promise<ActionResult> {
  try {
    await restoreEvent(eventId);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Appeals                                                                      */
/* -------------------------------------------------------------------------- */

export async function submitAppeal(input: {
  title: string;
  body: string;
}): Promise<ActionResult> {
  try {
    await createAppeal(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function changeAppealStatus(input: {
  id: string;
  status: AppealStatus;
}): Promise<ActionResult> {
  try {
    await setAppealStatus(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function changeAppealReply(input: {
  id: string;
  reply: string;
}): Promise<ActionResult> {
  try {
    await setAppealReply(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function removeAppeal(id: string): Promise<ActionResult> {
  try {
    await deleteAppeal(id);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Polls                                                                        */
/* -------------------------------------------------------------------------- */

export async function submitPoll(input: {
  question: string;
  description: string;
  multiple: boolean;
  options: string[];
}): Promise<ActionResult> {
  try {
    await createPoll(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function castVote(input: {
  pollId: string;
  optionIds: string[];
}): Promise<ActionResult> {
  try {
    await voteInPoll(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function changePollStatus(input: {
  pollId: string;
  status: "open" | "closed";
}): Promise<ActionResult> {
  try {
    await setPollStatus(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function removePoll(pollId: string): Promise<ActionResult> {
  try {
    await deletePoll(pollId);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Map                                                                          */
/* -------------------------------------------------------------------------- */

export async function saveWorkPoint(input: WorkPointInput): Promise<ActionResult> {
  try {
    await upsertWorkPoint(input);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function removeWorkPoint(id: string): Promise<ActionResult> {
  try {
    await deleteWorkPoint(id);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Custom roles                                                                  */
/* -------------------------------------------------------------------------- */

export async function loadCustomRoles(): Promise<ActionResult<CustomRoleRecord[]>> {
  try {
    return { ok: true, data: await listCustomRoles() };
  } catch (error) {
    return fail(error);
  }
}

export async function loadRoleGrants(roleId?: number): Promise<ActionResult<RoleGrantRecord[]>> {
  try {
    return { ok: true, data: await listRoleGrants(roleId) };
  } catch (error) {
    return fail(error);
  }
}

export async function saveCustomRole(input: {
  roleId?: number;
  name: string;
  description: string;
  actions: readonly string[];
}): Promise<ActionResult<number | null>> {
  try {
    if (input.roleId === undefined) {
      return { ok: true, data: await createCustomRole(input) };
    }
    await updateCustomRole({ ...input, roleId: input.roleId });
    return { ok: true, data: null };
  } catch (error) {
    return fail(error);
  }
}

export async function dropCustomRole(roleId: number): Promise<ActionResult> {
  try {
    await deleteCustomRole(roleId);
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error);
  }
}

export async function applyRoleGrants(input: {
  roleId: number;
  steamIds: readonly string[];
  mode: "grant" | "revoke";
}): Promise<ActionResult<RoleGrantResult>> {
  try {
    const result =
      input.mode === "grant"
        ? await grantCustomRole({ roleId: input.roleId, steamIds: input.steamIds })
        : await revokeCustomRole({ roleId: input.roleId, steamIds: input.steamIds });
    return { ok: true, data: result };
  } catch (error) {
    return fail(error);
  }
}
