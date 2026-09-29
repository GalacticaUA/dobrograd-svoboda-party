"use client";

import { Fragment, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, Plus, UserMinus } from "lucide-react";
import { toast } from "sonner";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState, fieldCls } from "@/components/portal/primitives";
import { RoleBadges } from "@/components/roles/role-badges";
import { useRoleOptions, useRolesStore } from "@/components/roles/roles-store";
import { saveHoursAdjustment, saveMemberRemoval, saveMemberStatus } from "@/lib/portal/actions";
import { steamProfileUrl } from "@/lib/auth/profile";
import { ROLE_LABEL } from "@/lib/role-labels";
import type { Action } from "@/lib/permissions";
import type { ApprovalStatus, ProfileRecord } from "@/types/auth";
import type { Role } from "@/types/party";

/**
 * Every account that has ever signed in through Steam, with the three things the
 * council does to a person: change their roles, expel them, correct their hours.
 *
 * This table is the reason `listProfiles()` exists. The review queue shows
 * accounts waiting on a decision; it is a to-do list, and a to-do list that also
 * contains four hundred settled rows stops being one. The people list is the
 * opposite — nothing here is a queue, it is a roster, and the reviewer scans it
 * when they need to find somebody.
 *
 * Roles are a stack, not a dropdown, since a person can hold several at once. The
 * column reads and writes through the shared store, so a change made in the role
 * editor's modal — a different component, in a different part of the page — lands
 * here in the same tick instead of after a reload.
 *
 * Every action is a `profile.setRole`, `profile.remove` or `registry.editHours`
 * call, which re-checks the effective permissions server-side. The `held.has(...)`
 * calls here are the advisory half of that pair: they decide what to draw, not
 * what is permitted. They read the set the server built rather than the viewer's
 * built-in role, so a database role that grants one of these draws the button.
 */

const STATUS_VARIANT: Record<ApprovalStatus, "default" | "secondary" | "destructive"> = {
  approved: "default",
  pending: "secondary",
  rejected: "destructive",
};

const STATUS_LABEL: Record<ApprovalStatus, string> = {
  approved: "Участник",
  pending: "Ожидает",
  rejected: "Исключён",
};

/** `2026-09-28T…` -> `28.09.2026`, without pulling in a date library. */
function formatDay(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return "—";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(parsed.getDate())}.${pad(parsed.getMonth() + 1)}.${parsed.getFullYear()}`;
}

export function PeopleTable({
  initialProfiles,
  permissions,
  viewerSteamId,
  viewerRoles,
}: {
  initialProfiles: ProfileRecord[];
  permissions: readonly Action[];
  viewerSteamId: string;
  /** The viewer's built-in roles, for the role editor's rules. Not the permission list. */
  viewerRoles: readonly Role[];
}) {
  const router = useRouter();
  const [profiles, setProfiles] = useState(initialProfiles);

  // A `router.refresh()` hands down a new list, and that list is newer than
  // anything held in state — several call sites below refresh precisely to resync
  // after a refusal. React's answer for "the props changed, throw away the state
  // derived from the old ones" is to compare during render rather than in an
  // effect, because an effect would mean rendering the stale table once more first
  // and then correcting it in a second pass.
  const [renderedFrom, setRenderedFrom] = useState(initialProfiles);
  if (renderedFrom !== initialProfiles) {
    setRenderedFrom(initialProfiles);
    setProfiles(initialProfiles);
  }

  const [busyId, setBusyId] = useState<string | null>(null);
  const [hoursFor, setHoursFor] = useState<string | null>(null);
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  const store = useRolesStore();
  const { seed: seedRoles } = store;
  const { addable, removable } = useRoleOptions(viewerRoles);

  // Hand the roster to the store, so the role editor's modal and the portal
  // registry can see the same people. Without this the modal would have to fetch
  // its own list, and the two lists would be fetched at different moments.
  //
  // Keyed on `initialProfiles` rather than run once, and keyed on `seed` rather
  // than on the store object: the store's identity changes on every confirmed
  // edit, so depending on it would re-seed from props that predate the edit and
  // undo the change the user just made. A `router.refresh()` really does hand
  // down a new list, and that list is newer than anything held here, so taking it
  // is what makes the refresh mean something.
  useEffect(() => {
    seedRoles(
      initialProfiles.map((profile) => ({
        steamId: profile.steamId,
        displayName: profile.displayName,
        persona: profile.persona,
        status: profile.status,
        roles: profile.roles,
      })),
    );
  }, [initialProfiles, seedRoles]);

  // The set is the page's effective permissions, resolved on the server from the
  // built-in roles *and* any database role, and handed down as a prop. There is no
  // provider here: this table is not inside the portal dialog, and building a
  // context around one component that already has its answer would be noise.
  const held = useMemo(() => new Set<Action>(permissions), [permissions]);

  const maySetRole = held.has("profile.setRole");
  const mayRemove = held.has("profile.remove");
  const mayEditHours = held.has("registry.editHours");

  function patch(steamId: string, changes: Partial<ProfileRecord>) {
    setProfiles((previous) =>
      previous.map((item) => (item.steamId === steamId ? { ...item, ...changes } : item)),
    );
  }

  /**
   * Add one role from the `+` menu.
   *
   * The status side effect is the same one the old dropdown had: promoting
   * somebody who only ever signed in has to approve them too, or they would hold a
   * role the database still calls pending and `requireSession` would keep throwing
   * on every page they open. Done after the role lands, so a refusal leaves the row
   * exactly as it was rather than approved with no role.
   */
  function addRole(profile: ProfileRecord, role: Role) {
    setBusyId(profile.steamId);
    setAddingFor(null);

    startTransition(async () => {
      const result = await store.add(profile.steamId, role);

      setBusyId(null);

      if (!result.ok) {
        router.refresh();
        return;
      }

      const approved = profile.status === "pending" ? "approved" : profile.status;

      if (approved !== profile.status) {
        // Status only. This used to send the role back as well — `saveMemberRole`
        // took a single role and replaced the whole set with it — which meant
        // approving somebody who already held two roles silently dropped one. The
        // role landed a moment ago through `store.add`; nothing here needs to
        // repeat it, and repeating it is the part that was destructive.
        const statusResult = await saveMemberStatus(profile.steamId, approved);

        if (!statusResult.ok) {
          toast.error(statusResult.error);
          router.refresh();
          return;
        }

        patch(profile.steamId, { status: approved });
      }

      toast.success(`${profile.displayName}: роль ${ROLE_LABEL[role].toLowerCase()}`);
    });
  }

  /** The `×` on a badge. */
  function removeRole(profile: ProfileRecord, role: Role) {
    setBusyId(profile.steamId);

    startTransition(async () => {
      const result = await store.remove(profile.steamId, role);

      setBusyId(null);

      if (!result.ok) {
        router.refresh();
        return;
      }

      toast.success(`${profile.displayName}: роль «${ROLE_LABEL[role]}» снята`);
    });
  }

  function expel(profile: ProfileRecord, reason: string) {
    if (!reason.trim()) {
      toast.error("Укажите причину — она попадёт в журнал");
      return;
    }

    setBusyId(profile.steamId);

    startTransition(async () => {
      const result = await saveMemberRemoval({ steamId: profile.steamId, reason: reason.trim() });

      setBusyId(null);

      if (!result.ok) {
        toast.error(result.error);
        router.refresh();
        return;
      }

      patch(profile.steamId, { status: "rejected" });
      setHoursFor(null);
      toast.success(`${profile.displayName} исключён`);
    });
  }

  if (profiles.length === 0) {
    return (
      <EmptyState
        title="Аккаунтов пока нет"
        hint="Здесь появятся все, кто вошёл через Steam - и ожидающие, и участники."
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground py-2 m-0">
        Всего: <span className="text-cloud">{profiles.length}</span> · ожидают:{" "}
        <span className="text-amber-400">{profiles.filter((p) => p.status === "pending").length}</span>
      </p>

      <div className="rounded-2xl border border-border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Аккаунт</TableHead>
              <TableHead>Роли</TableHead>
              <TableHead>Статус</TableHead>
              <TableHead>Discord</TableHead>
              <TableHead>Вход</TableHead>
              <TableHead>Действия</TableHead>
            </TableRow>
          </TableHeader>

          <TableBody>
            {profiles.map((profile) => {
              const busy = busyId === profile.steamId;
              const isSelf = profile.steamId === viewerSteamId;

              // Read through the store, not through `profile.roles`, so a change made
              // in the role editor's modal shows up in this row. The prop is only
              // the seed.
              const roles = store.rolesOf(profile.steamId);
              const canAdd = maySetRole ? addable(profile.steamId) : [];
              const canRemove = maySetRole ? removable(profile.steamId) : [];
              const adding = addingFor === profile.steamId;

              return (
                <Fragment key={profile.steamId}>
                  <TableRow className={busy ? "opacity-60" : undefined}>
                    <TableCell className="font-medium text-cloud">
                      {profile.displayName}
                      {isSelf ? <span className="ml-2 text-xs text-primary">это вы</span> : null}
                      <a
                        href={steamProfileUrl(profile.steamId)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="block font-mono text-xs font-normal text-muted-foreground hover:text-primary"
                      >
                        {profile.steamId}
                      </a>
                    </TableCell>

                    <TableCell>
                      <div className="flex flex-wrap items-center gap-2">
                        <RoleBadges
                          roles={roles}
                          removable={canRemove}
                          onRemove={(role) => removeRole(profile, role)}
                        />

                        {maySetRole && canAdd.length > 0 ? (
                          adding ? (
                            <select
                              // A value-less select with a placeholder renders the
                              // placeholder, which is the honest state here: nothing
                              // has been chosen yet. Autofocus because the click that
                              // opened it is the click the reviewer is in the middle of.
                              autoFocus
                              defaultValue=""
                              onChange={(event) => {
                                const chosen = event.target.value;
                                if (chosen) addRole(profile, chosen as Role);
                                else setAddingFor(null);
                              }}
                              onBlur={() => setAddingFor(null)}
                              aria-label={`Добавить роль: ${profile.displayName}`}
                              className="rounded-lg border border-primary/60 bg-background px-2 py-1 text-sm text-cloud outline-none"
                            >
                              <option value="" disabled>
                                выберите…
                              </option>
                              {canAdd.map((role) => (
                                <option key={role} value={role}>
                                  {ROLE_LABEL[role]}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => setAddingFor(profile.steamId)}
                              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground transition hover:border-primary/60 hover:text-primary disabled:opacity-40"
                            >
                              <Plus className="h-3 w-3" aria-hidden />
                              Добавить роль
                            </button>
                          )
                        ) : null}
                      </div>
                    </TableCell>

                    <TableCell>
                      <Badge variant={STATUS_VARIANT[profile.status]}>
                        {STATUS_LABEL[profile.status]}
                      </Badge>
                    </TableCell>

                    <TableCell className="text-sm text-muted-foreground">
                      {profile.discord || "—"}
                    </TableCell>

                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {formatDay(profile.createdAt)}
                    </TableCell>

                    <TableCell>
                      <div className="flex gap-2">
                        {mayEditHours ? (
                          <button
                            type="button"
                            onClick={() => setHoursFor(hoursFor === profile.steamId ? null : profile.steamId)}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-cloud transition hover:border-primary/60"
                          >
                            <Clock className="h-3.5 w-3.5" aria-hidden />
                            Часы
                          </button>
                        ) : null}

                        {mayRemove ? (
                          <button
                            type="button"
                            disabled={busy || isSelf}
                            title={isSelf ? "Нельзя исключить самого себя" : undefined}
                            onClick={() => {
                              const reason = window.prompt(
                                `Причина исключения ${profile.displayName}:`,
                                "",
                              );
                              if (reason !== null) expel(profile, reason);
                            }}
                            className="inline-flex items-center gap-1 rounded-full border border-border bg-card/60 px-3 py-1.5 text-xs text-cloud transition hover:border-destructive/60 disabled:opacity-40"
                          >
                            <UserMinus className="h-3.5 w-3.5" aria-hidden />
                            Исключить
                          </button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>

                  {hoursFor === profile.steamId ? (
                    <HoursRow
                      displayName={profile.displayName}
                      onCancel={() => setHoursFor(null)}
                      onSave={(hours, reason) => {
                        setBusyId(profile.steamId);
                        startTransition(async () => {
                          const result = await saveHoursAdjustment({
                            steamId: profile.steamId,
                            hours,
                            reason,
                          });
                          setBusyId(null);
                          if (!result.ok) {
                            toast.error(result.error);
                            return;
                          }
                          setHoursFor(null);
                          toast.success("Часы добавлены");
                          router.refresh();
                        });
                      }}
                    />
                  ) : null}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/**
 * The hour correction row, inline under the member it belongs to.
 *
 * Inline rather than in a dialog because the reviewer is comparing against the
 * roster: opening a modal to type two numbers loses the surrounding context, and a
 * second dialog stacked on the table is exactly the N+1 problem the registry tab
 * already paid for once. It renders only while open, so it costs nothing when it
 * is not.
 */
function HoursRow({
  displayName,
  onSave,
  onCancel,
}: {
  displayName: string;
  onSave: (hours: number, reason: string) => void;
  onCancel: () => void;
}) {
  const [hours, setHours] = useState("1");
  const [reason, setReason] = useState("");

  const parsed = Number(hours.replace(",", "."));
  const valid = Number.isFinite(parsed) && parsed !== 0;

  return (
    <TableRow className="bg-background/40">
      <TableCell colSpan={6}>
        <div className="flex flex-wrap items-end gap-3 py-1">
          <label className="text-xs text-muted-foreground">
            Часы
            <input
              value={hours}
              onChange={(event) => setHours(event.target.value)}
              inputMode="decimal"
              aria-label="Количество часов"
              className={`mt-1 w-24 ${fieldCls}`}
            />
          </label>

          <label className="min-w-56 flex-1 text-xs text-muted-foreground">
            Причина
            <input
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Например: субботник сверх расписания"
              aria-label="Причина"
              className={`mt-1 ${fieldCls}`}
            />
          </label>

          <button
            type="button"
            disabled={!valid}
            onClick={() => onSave(parsed, reason.trim())}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-50"
          >
            Записать
          </button>

          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-border px-4 py-2 text-sm text-cloud transition hover:border-primary/60"
          >
            Отмена
          </button>

          <p className="w-full text-xs text-muted-foreground">
            Спишется {valid ? parsed : 0} ч. {displayName} отрицательное значение снимает ранее
            начисленные часы.
          </p>
        </div>
      </TableCell>
    </TableRow>
  );
}
