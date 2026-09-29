"use client";

import { useCallback, useEffect, useState, useTransition } from "react";
import { AtSign, Check, Clock, Loader2, Pencil, Plus, Save, Shield, Trash2, UserMinus, Users } from "lucide-react";
import { toast } from "sonner";

import { EmptyState, LoadingBlock, PageTitle, Panel, fieldCls } from "@/components/portal/primitives";
import { RoleBadges } from "@/components/roles/role-badges";
import { useRolesStore, useRoleOptions } from "@/components/roles/roles-store";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  dropHoursAdjustment,
  loadMemberHours,
  loadRegistry,
  saveHoursAdjustment,
  saveMemberProfile,
  saveMemberRemoval,
  saveMemberRoles,
  saveMemberStatus,
} from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { displayNameOf, type HoursAdjustmentRecord, type RegistryEntry } from "@/lib/portal/types";
import { ROLE_LABEL } from "@/lib/role-labels";
import type { ApprovalStatus, ProfileDTO } from "@/types/auth";
import type { Role } from "@/types/party";
import { useCan } from "@/components/portal/permissions";
import { ASSIGNABLE_ROLES, applyChange } from "@/lib/permissions";

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  approved: "Одобрен",
  pending: "На рассмотрении",
  rejected: "Отклонён",
};

/**
 * The member registry.
 *
 * Note what this tab is *not*: it does not fetch contact details and hide them in
 * the component. The DAL already strips telegram, discord and phone from rows the
 * caller may not see, so a member who is not staff and has not opened their
 * contacts receives nulls from the server. A client-side check would be one
 * `useState` mistake away from leaking everyone's phone number.
 */
export function RegistryTab({ profile }: { profile: ProfileDTO }) {
  const { data, error, pending, refresh } = useAsyncData<RegistryEntry[]>(loadRegistry);
  const [query, setQuery] = useState("");
  const { seed: seedRoles } = useRolesStore();
  // Above the early returns: these are hooks, and the loading and error branches
  // are still renders of this component.
  const maySetRole = useCan("profile.setRole");
  // Matches the DAL's own test for handing out contact detail, which is
  // `profile.editAny` rather than `report.viewAll` — reading somebody's hours is
  // not what entitles you to their phone number.
  const mayEditOthers = useCan("profile.editAny");
  const mayRemove = useCan("profile.remove");

  /**
   * Hand the registry to the shared store.
   *
   * The portal dialog and the admin panel are different subtrees, so this is the
   * only way a role granted in the admin panel's role editor can appear here
   * without closing the portal and reloading it. What is seeded is exactly what
   * `loadRegistry` returned — names, status, roles, nothing else — so the store
   * never knows more about the party than this tab already did.
   *
   * The dependency is `seed` and not the store object. The store's identity changes
   * on every confirmed edit — that is what makes it re-render the people table —
   * so depending on the whole object re-ran this effect after each change and
   * re-seeded the roles from `data`, which had been loaded before the edit. The
   * effect would undo the promotion it was supposed to be showing. `seed` itself is
   * created once for the provider's lifetime, so this fires when the data really is
   * new and not when the store is.
   */
  useEffect(() => {
    if (!data) return;
    seedRoles(
      data.map((entry) => ({
        steamId: entry.steamId,
        displayName: entry.displayName || entry.persona,
        persona: entry.persona,
        status: entry.status,
        roles: entry.roles,
      })),
    );
  }, [data, seedRoles]);

  if (pending) return <LoadingBlock />;
  if (error) {
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">{error}</p>
        <button type="button" onClick={() => refresh()} className="mt-3 text-sm text-primary hover:underline">
          Повторить
        </button>
      </Panel>
    );
  }

  const all = data ?? [];
  const needle = query.trim().toLowerCase();
  const rows = needle
    ? all.filter((entry) =>
        [entry.displayName, entry.persona, entry.telegram, entry.discord, entry.steamId]
          .filter(Boolean)
          .some((field) => String(field).toLowerCase().includes(needle)),
      )
    : all;

  return (
    <div className="space-y-4">
      <PageTitle
        title="Реестр"
        sub={`Участников партии: ${all.length}`}
        action={
          <div className="relative">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Поиск"
              className={`${fieldCls} w-40 sm:w-56`}
            />
          </div>
        }
      />

      {rows.length === 0 ? (
        <EmptyState title="Никого не нашлось" hint={all.length === 0 ? "Реестр пока пуст." : "Попробуйте другой запрос."} />
      ) : (
        <ul className="space-y-3">
          {rows.map((entry) => (
            <RegistryCard
              key={entry.steamId}
              entry={entry}
              /* An admin's role is not changed through the interface, so the
                 button is withheld rather than shown-and-refused. The DAL would
                 reject the save anyway; hiding it keeps the page from offering a
                 thing that cannot happen. */
              canSetRole={maySetRole && !entry.roles.includes("admin")}
              canEdit={mayEditOthers}
              canRemove={mayRemove}
              viewerId={profile.steamId}
              viewerRoles={profile.roles}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function RegistryCard({
  entry,
  canSetRole,
  canEdit,
  canRemove,
  viewerId,
  viewerRoles,
  onChanged,
}: {
  entry: RegistryEntry;
  canSetRole: boolean;
  canEdit: boolean;
  canRemove: boolean;
  viewerId: string;
  viewerRoles: readonly Role[];
  onChanged: () => void;
}) {
  const store = useRolesStore();
  const { addable, removable } = useRoleOptions(viewerRoles);
  const [editing, setEditing] = useState(false);
  // Read through the store, so a change made in the admin panel's role editor is
  // on this card before anybody reopens the portal.
  const roles = store.rolesOf(entry.steamId);
  // Seeded once, when the card mounts. Re-derived from the store on every change
  // instead, and the box the reviewer just ticked would spring back under them.
  const [picked, setPicked] = useState<Role[]>(roles);
  const [status, setStatus] = useState<ApprovalStatus>(entry.status);
  const [saving, startTransition] = useTransition();

  const [nameOpen, setNameOpen] = useState(false);
  const [hoursOpen, setHoursOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const hasContacts = Boolean(entry.telegram || entry.discord || entry.phone);

  // The server refuses both of these regardless, but a button you can press and
  // then be told "нельзя" is a worse experience than not having the button, and
  // the guards in the DAL exist for callers who are not this component.
  /* Expelling an admin is the same act as demoting them — the removal clears the
     roles — so the admin is not offered for removal either. The DAL checks this
     again; this keeps the button from appearing at all. */
  const removableMember = canRemove && entry.steamId !== viewerId && !roles.includes("admin");

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveMemberRoles({ steamId: entry.steamId, roles: picked });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }

      // The status is a separate column with a separate reason for existing, so it
      // is a separate call. Both are reported as one edit because to the reviewer
      // they are one edit.
      if (status !== entry.status) {
        const statusResult = await saveMemberStatus(entry.steamId, status);
        if (!statusResult.ok) {
          toast.error(statusResult.error);
          return;
        }
      }

      toast.success("Роли обновлены");
      setEditing(false);
      onChanged();
    });
  };

  return (
    <Panel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium text-cloud">
            {displayNameOf(entry)}
            {entry.status !== "approved" && (
              <span className="ml-2 text-xs text-muted-foreground">{STATUS_LABELS[entry.status]}</span>
            )}
          </p>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            Steam: {entry.persona || "—"} · {entry.steamId}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <RoleBadges roles={roles} />
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Clock className="h-3 w-3" />
            {entry.totalHours} ч
          </span>
        </div>
      </div>

      {entry.about && <p className="mt-2 text-sm text-muted-foreground">{entry.about}</p>}

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <Users className="h-3 w-3" />
          было: {entry.eventsAttended}
          {entry.eventsAbsent > 0 ? `, пропущено: ${entry.eventsAbsent}` : ""}
        </span>
        {hasContacts ? (
          <>
            {entry.telegram && (
              <span className="inline-flex items-center gap-1 text-primary">
                <AtSign className="h-3 w-3" />
                {entry.telegram}
              </span>
            )}
            {entry.discord && <span>Discord: {entry.discord}</span>}
            {entry.phone && <span>Телефон: {entry.phone}</span>}
          </>
        ) : (
          !entry.contactsPublic && <span>Контакты скрыты участником</span>
        )}
      </div>

      {canEdit && !editing && (
        <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
          <CardAction icon={<Clock className="h-3.5 w-3.5" />} onClick={() => setHoursOpen(true)}>
            Часы
          </CardAction>
          <CardAction icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setNameOpen(true)}>
            Имя и описание
          </CardAction>
          {canSetRole && (
            <CardAction icon={<Shield className="h-3.5 w-3.5" />} onClick={() => setEditing(true)}>
              Изменить роль
            </CardAction>
          )}
          {removableMember && (
            <CardAction
              icon={<UserMinus className="h-3.5 w-3.5" />}
              onClick={() => setRemoveOpen(true)}
              tone="danger"
            >
              Исключить
            </CardAction>
          )}
        </div>
      )}

      {canSetRole && editing && (
        <form onSubmit={submit} className="mt-3 space-y-3 border-t border-border pt-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {/*
              A list of ticks rather than a select, because a person can hold more
              than one role and a select can only ever hold one. This is the same
              question the people table asks with a `+` menu, and the same set of
              boxes: `ASSIGNABLE_ROLES`, which excludes `admin` — the party grants
              that by hand in the database, and the label map has to name it so it
              can be *displayed* on a card, which is a different thing from offering
              it as a choice. The rest of the rules — one leader at a time, not the
              last appointer out — need party-wide counts this card does not have,
              so they are left to the DAL, which re-checks and reports back.
            */}
            <fieldset className="text-sm text-clock">
              <legend className="mb-1">Роли</legend>
              <div className="space-y-1">
                {ASSIGNABLE_ROLES.map((value) => {
                  // A role this viewer may neither give nor take — the last
                  // appointer's own `leader`, say — is drawn as a static fact
                  // rather than a box that would be refused on submit.
                  const editable =
                    addable(entry.steamId).includes(value) || removable(entry.steamId).includes(value);

                  if (!editable) {
                    return (
                      <p key={value} className="flex items-center gap-2 text-muted-foreground">
                        {roles.includes(value) ? (
                          <>
                            <Check className="h-3.5 w-3.5" aria-hidden />
                            {ROLE_LABEL[value]}
                          </>
                        ) : (
                          <span className="pl-5.5 opacity-40">{ROLE_LABEL[value]}</span>
                        )}
                      </p>
                    );
                  }

                  const checked = picked.includes(value);

                  return (
                    <label key={value} className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() =>
                          setPicked((previous) =>
                            applyChange(previous, checked
                              ? { kind: "remove", role: value }
                              : { kind: "add", role: value }),
                          )
                        }
                      />
                      <span>{ROLE_LABEL[value]}</span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <label className="text-sm text-clock">
              Статус
              <select
                value={status}
                onChange={(event) => setStatus(event.target.value as ApprovalStatus)}
                className={`${fieldCls} mt-1`}
              >
                {Object.entries(STATUS_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setEditing(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Сохранить
            </button>
          </div>
        </form>
      )}

      {/*
        Mounted only while open, on purpose. `HoursDialog` fetches on mount, and
        the registry renders one card per member — keeping the dialogs mounted
        would fire one request per person before the user has looked at a single
        one. Mounting on open also re-seeds the name and reason fields from the
        current row, so a dialog reopened after a refresh shows what is actually
        stored rather than what was typed twenty minutes ago.
      */}
      {nameOpen && (
        <MemberNameDialog onOpenChange={setNameOpen} entry={entry} onSaved={onChanged} />
      )}
      {hoursOpen && (
        <HoursDialog onOpenChange={setHoursOpen} entry={entry} onChanged={onChanged} />
      )}
      {removeOpen && (
        <RemoveDialog onOpenChange={setRemoveOpen} entry={entry} onRemoved={onChanged} />
      )}
    </Panel>
  );
}

function CardAction({
  icon,
  onClick,
  children,
  tone = "default",
}: {
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        tone === "danger"
          ? "inline-flex items-center gap-1.5 rounded-lg border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition hover:bg-destructive/10"
          : "inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud"
      }
    >
      {icon}
      {children}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Nickname                                                                     */
/* -------------------------------------------------------------------------- */

function MemberNameDialog({
  onOpenChange,
  entry,
  onSaved,
}: {
  onOpenChange: (open: boolean) => void;
  entry: RegistryEntry;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(entry.displayName);
  const [about, setAbout] = useState(entry.about);
  const [saving, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveMemberProfile({
        steamId: entry.steamId,
        displayName,
        about,
      });
      if (result.ok) {
        toast.success("Профиль обновлён");
        onOpenChange(false);
        onSaved();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-base text-cloud">
            {displayNameOf(entry)}
          </DialogTitle>
          <DialogDescription>
            Имя и описание участника. Контакты и роль здесь не меняются.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm text-clock">
            Имя
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              maxLength={60}
              required
              className={`${fieldCls} mt-1`}
            />
          </label>
          <label className="block text-sm text-clock">
            О себе
            <textarea
              value={about}
              onChange={(event) => setAbout(event.target.value)}
              rows={3}
              maxLength={1000}
              className={`${fieldCls} mt-1`}
            />
          </label>
          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
              Сохранить
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Hours                                                                        */
/* -------------------------------------------------------------------------- */

function formatHours(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "");
}

/**
 * Manual hours corrections for one member.
 *
 * The corrections are listed rather than only summed, because a total that
 * quietly absorbs an edit is a number nobody can check: if a member's hours stop
 * matching the events they attended, this is where the reason has to be. Each row
 * can be deleted, which is also the way to undo a mistake without leaving a
 * negative entry behind as a scar.
 */
function HoursDialog({
  onOpenChange,
  entry,
  onChanged,
}: {
  onOpenChange: (open: boolean) => void;
  entry: RegistryEntry;
  onChanged: () => void;
}) {
  const [hours, setHours] = useState("");
  const [reason, setReason] = useState("");
  const [saving, startTransition] = useTransition();

  const load = useCallback(() => loadMemberHours(entry.steamId), [entry.steamId]);
  const { data, error, pending, refresh } = useAsyncData<HoursAdjustmentRecord[]>(load, entry.steamId);

  const adjustments = data ?? [];
  const adjustedTotal = adjustments.reduce((sum, row) => sum + row.hours, 0);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    const parsed = Number(hours.replace(",", "."));
    if (!Number.isFinite(parsed) || parsed === 0) {
      toast.error("Укажите количество часов");
      return;
    }

    startTransition(async () => {
      const result = await saveHoursAdjustment({
        steamId: entry.steamId,
        hours: parsed,
        reason,
      });
      if (result.ok) {
        toast.success("Часы обновлены");
        setHours("");
        setReason("");
        refresh();
        onChanged();
      } else {
        toast.error(result.error);
      }
    });
  };

  const drop = (id: number) => {
    startTransition(async () => {
      const result = await dropHoursAdjustment(id);
      if (result.ok) {
        toast.success("Правка удалена");
        refresh();
        onChanged();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-base text-cloud">Часы: {displayNameOf(entry)}</DialogTitle>
          <DialogDescription>
            По событиям: {formatHours(entry.totalHours - adjustedTotal)} ч. Правок: {formatHours(adjustedTotal)} ч.
            Итого: {formatHours(entry.totalHours)} ч.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[8rem_1fr]">
            <label className="block text-sm text-clock">
              Часы
              <input
                value={hours}
                onChange={(event) => setHours(event.target.value)}
                inputMode="decimal"
                placeholder="2.5"
                className={`${fieldCls} mt-1`}
              />
            </label>
            <label className="block text-sm text-clock">
              Причина
              <input
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                maxLength={500}
                placeholder="Смена не попала в список"
                className={`${fieldCls} mt-1`}
              />
            </label>
          </div>

          <p className="text-xs text-muted-foreground">
            Со знаком минус часы снимаются. Одна правка - не больше 1440.
          </p>

          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
            >
              Закрыть
            </button>
            <button
              type="submit"
              disabled={saving || hours.trim() === ""}
              className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
            >
              <Plus className="h-3.5 w-3.5" />
              Добавить
            </button>
          </DialogFooter>
        </form>

        {pending ? (
          <LoadingBlock />
        ) : error ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : adjustments.length === 0 ? (
          <p className="text-sm text-muted-foreground">Правок нет - часы считаются только по событиям.</p>
        ) : (
          <ul className="space-y-2">
            {adjustments.map((row) => (
              <li
                key={row.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p
                    className={
                      row.hours < 0
                        ? "text-sm text-destructive"
                        : "text-sm text-cloud"
                    }
                  >
                    {row.hours > 0 ? "+" : "−"}
                    {formatHours(Math.abs(row.hours))} ч
                  </p>
                  {row.reason && <p className="mt-0.5 text-xs text-muted-foreground">{row.reason}</p>}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {row.author ?? "система"} · {new Date(row.createdAt).toLocaleString("ru-RU")}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => drop(row.id)}
                  disabled={saving}
                  aria-label="Удалить правку"
                  className="rounded-lg border border-border p-1.5 text-muted-foreground transition hover:border-destructive hover:text-destructive disabled:opacity-60"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* -------------------------------------------------------------------------- */
/* Removal                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Expel a member from the party.
 *
 * The copy has to be exact about what happens, because the obvious misreading is
 * that this deletes their account. It does not: their Steam login keeps working,
 * the portal closes, and they may file a new application. Saying "аккаунт удалён"
 * here would make staff afraid to use the button.
 */
function RemoveDialog({
  onOpenChange,
  entry,
  onRemoved,
}: {
  onOpenChange: (open: boolean) => void;
  entry: RegistryEntry;
  onRemoved: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveMemberRemoval({ steamId: entry.steamId, reason });
      if (result.ok) {
        toast.success("Участник исключён");
        setReason("");
        onOpenChange(false);
        onRemoved();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="font-display text-base text-destructive">
            Исключить {displayNameOf(entry)}?
          </DialogTitle>
          <DialogDescription>
            Доступ к порталу и данным партии сразу закрывается, история часов и обращений сохраняется.
            Аккаунт Steam остаётся рабочим - участник сможет снова подать заявку на вступление.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm text-clock">
            Причина
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={2}
              maxLength={500}
              required
              className={`${fieldCls} mt-1`}
            />
          </label>
          <p className="text-xs text-muted-foreground">Причина попадёт в журнал действий.</p>
          <DialogFooter>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving || reason.trim() === ""}
              className="inline-flex items-center gap-2 rounded-lg bg-destructive px-3 py-1.5 text-xs text-destructive-foreground disabled:opacity-60"
            >
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserMinus className="h-3.5 w-3.5" />}
              Исключить
            </button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
