"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { EmptyState, Panel, fieldCls } from "@/components/portal/primitives";
import { BuiltInRoleSection } from "@/components/roles/role-members-dialog";
import { applyRoleGrants, dropCustomRole, loadRoleGrants, loadCustomRoles, saveCustomRole } from "@/lib/portal/actions";
import { ACTION_GROUPS, ACTION_LABELS, type Action } from "@/lib/permissions";
import type { CustomRoleRecord, RoleGrantRecord } from "@/lib/portal/types";
import type { ProfileRecord } from "@/types/auth";
import type { Role } from "@/types/party";

/**
 * Roles, in two senses, and the confusion between them was the reason this file
 * was called "role manager" while mostly managing permission bundles.
 *
 * The built-in roles — leader, admin, moderator — are the ones the party appoints
 * and the ones the database guarantees the shape of (one leader, at least one
 * appointer). They are edited through the shared store and the dialog at the top of
 * this file.
 *
 * The custom roles below are *additive permission bundles*: a name and a list of
 * actions, granted on top of whatever built-in role a person already has. They are
 * a separate table, a separate grant path, and a separate set of rules — most
 * importantly they can never contain `profile.setRole`, so no bundle can make
 * somebody a leader or an admin no matter who builds it.
 *
 * Two ideas are worth reading before the JSX.
 *
 * First, the checkbox list is *not* the full action list. It is exactly the set of
 * permissions the viewer holds, resolved on the server, minus `profile.setRole`
 * which no role may contain. That is the same list the DAL validates against
 * (`canGrantAll`) and the same list `isGrantable` filters on the way back in, so
 * the three cannot drift: there is no second place where a permission could be
 * offered. The consequence worth knowing is that an admin editing somebody else's
 * role sees fewer checkboxes than an admin editing their own — which is correct,
 * and the reason the form says so.
 *
 * Second, granting is additive and never touches the built-in roles. Nothing here
 * can make somebody a leader, and nothing here can take a built-in role away. A
 * custom role is an extra hat, and taking it off is always safe.
 */

interface Draft {
  roleId?: number;
  name: string;
  description: string;
  actions: Action[];
}

const EMPTY_DRAFT: Draft = { name: "", description: "", actions: [] };

/**
 * Russian count agreement, which has three forms and no zero form.
 *
 * Written out rather than pulled in for one string, since a pluralisation library
 * is a dependency for a single call site.
 */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 14) return many;
  const mod10 = n % 10;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function RoleManager({
  initialRoles,
  grantable,
  profiles,
  viewerRoles,
}: {
  initialRoles: CustomRoleRecord[];
  /** The viewer's own permissions, minus what may not be delegated. */
  grantable: readonly Action[];
  /** Candidates for a batch grant. Approved members only, supplied by the server. */
  profiles: ProfileRecord[];
  /** The viewer's built-in roles, for the built-in role dialog's rules. */
  viewerRoles: readonly Role[];
}) {
  const router = useRouter();
  const [roles, setRoles] = useState(initialRoles);
  const [grants, setGrants] = useState<RoleGrantRecord[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, startTransition] = useTransition();

  const held = useMemo(() => new Set<Action>(grantable), [grantable]);
  const candidates = useMemo(
    () => profiles.filter((profile) => profile.status === "approved"),
    [profiles],
  );

  /**
   * Who holds what, fetched once on mount.
   *
   * Without this the component believed nobody held any role until the first
   * grant or revoke completed, because `grants` was only ever written by
   * `refresh()` after an action. Every consequence was wrong in the same
   * direction: the "уже есть" badge never appeared, the two counters on the
   * buttons were computed against an empty list, and the picker could not tell a
   * new person from an existing holder. The page already had the role list from
   * the server; the grants are the one piece it could not be given up front
   * without a query, so they are fetched here instead.
   *
   * Deliberately not run through `startTransition`, so this does not mark the
   * tree as pending and re-disable the buttons that were just enabled.
   */
  useEffect(() => {
    let live = true;

    void loadRoleGrants().then((result) => {
      if (!live) return;
      if (result.ok) setGrants(result.data);
      else toast.error(result.error);
    });

    return () => {
      live = false;
    };
  }, []);

  function refresh() {
    startTransition(async () => {
      const [roleList, grantList] = await Promise.all([loadCustomRoles(), loadRoleGrants()]);
      if (roleList.ok) setRoles(roleList.data);
      else toast.error(roleList.error);
      if (grantList.ok) setGrants(grantList.data);
    });
  }

  function save() {
    if (!draft) return;

    startTransition(async () => {
      const result = await saveCustomRole({
        roleId: draft.roleId,
        name: draft.name,
        description: draft.description,
        actions: draft.actions,
      });

      if (!result.ok) {
        // The server's message is the useful one here: it is the only place that
        // knows which action was rejected and why.
        toast.error(result.error);
        return;
      }

      toast.success(draft.roleId === undefined ? "Роль создана" : "Роль сохранена");
      setDraft(null);
      refresh();
    });
  }

  function remove(role: CustomRoleRecord) {
    const holders = role.holderCount;

    if (holders > 0 && !window.confirm(`Роль «${role.name}» выдана ${holders} чел. Удаление снимет её у всех. Продолжить?`)) {
      return;
    }

    startTransition(async () => {
      const result = await dropCustomRole(role.id);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      toast.success("Роль удалена");
      refresh();
    });
  }

  /**
   * Hand a role to several people, or take it away, in one call.
   *
   * `settled` is called only when something actually changed, so the card can
   * clear its tick boxes. They are cleared rather than left in place because
   * after a grant the ticked people have become holders, which moves them from
   * the grant list to the revoke list — leaving them ticked would turn the next
   * press of the other button into an accidental bulk revoke of what was just
   * handed out.
   */
  function batch(
    roleId: number,
    steamIds: string[],
    mode: "grant" | "revoke",
    settled?: () => void,
  ) {
    if (steamIds.length === 0) {
      toast.error("Выберите хотя бы одного участника");
      return;
    }

    startTransition(async () => {
      const result = await applyRoleGrants({ roleId, steamIds, mode });

      if (!result.ok) {
        toast.error(result.error);
        if (result.reason) router.refresh();
        return;
      }

      const { applied, skipped } = result.data;
      const verb = mode === "grant" ? "выдана" : "снята";

      if (applied.length === 0) {
        toast.error(`Роль уже была ${verb} у всех выбранных`);
      } else {
        toast.success(`Роль ${verb}: ${applied.length}`, {
          description: skipped.length > 0 ? `Без изменений: ${skipped.length}` : undefined,
        });
        settled?.();
      }

      refresh();
    });
  }

  return (
    <div className="space-y-6">
      {/*
        Built-in roles first. They were previously only editable one person at a
        time from the people table, which is fine for a correction and wrong for
        handing a role out: to appoint a moderator you now open one dialog, see
        the whole party, and click. It reads the same shared store the people
        table writes to, so a click here moves a badge over there.
      */}
      <BuiltInRoleSection viewerRoles={viewerRoles} />

      <div className="space-y-4 border-t border-border pt-6">
        {roles.length === 0 && draft === null ? (
          <EmptyState
            title="Наборов прав пока нет"
            hint="Создайте набор - например, «Секретарь» с правом редактировать любые точки работы - и выдайте его участникам."
          />
        ) : null}

      {roles.map((role) => (
        <RoleCard
          key={role.id}
          role={role}
          grants={grants.filter((grant) => grant.roleId === role.id)}
          candidates={candidates}
          heldBy={(steamId) => grants.some((grant) => grant.roleId === role.id && grant.steamId === steamId)}
          disabled={busy}
          onEdit={() =>
            setDraft({
              roleId: role.id,
              name: role.name,
              description: role.description,
              actions: role.actions.filter((action) => held.has(action)),
            })
          }
          onDelete={() => remove(role)}
          onGrant={(steamIds, done) => batch(role.id, steamIds, "grant", done)}
          onRevoke={(steamIds, done) => batch(role.id, steamIds, "revoke", done)}
        />
      ))}

      {draft === null ? (
        <button
          type="button"
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
          className="rounded-lg border border-dashed border-border px-4 py-2.5 text-sm text-muted-foreground transition hover:border-primary hover:text-cloud"
        >
          + Создать набор прав
        </button>
      ) : (
        <RoleEditor
          draft={draft}
          grantable={grantable}
          disabled={busy}
          onChange={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      )}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function RoleEditor({
  draft,
  grantable,
  disabled,
  onChange,
  onSave,
  onCancel,
}: {
  draft: Draft;
  grantable: readonly Action[];
  disabled: boolean;
  onChange: (draft: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const selected = useMemo(() => new Set<Action>(draft.actions), [draft.actions]);

  function toggle(action: Action) {
    onChange({
      ...draft,
      actions: selected.has(action) ? draft.actions.filter((item) => item !== action) : [...draft.actions, action],
    });
  }

  return (
    <Panel className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Название</span>
          <input
            value={draft.name}
            onChange={(event) => onChange({ ...draft, name: event.target.value })}
            placeholder="Картограф"
            maxLength={60}
            className={fieldCls}
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">Описание (необязательно)</span>
          <input
            value={draft.description}
            onChange={(event) => onChange({ ...draft, description: event.target.value })}
            placeholder="Редактирует точки на карте"
            maxLength={300}
            className={fieldCls}
          />
        </label>
      </div>

      <div>
        <p className="mb-2 text-xs text-muted-foreground">
          Права роли - только те, что есть у вас. Назначение лидера в список не входит: встроенную роль
          меняют отдельно.
        </p>

        <div className="space-y-3">
          {ACTION_GROUPS.map((group) => {
            // A group the viewer holds nothing from is not shown as an empty
            // heading; an empty section reads as a bug rather than a limit.
            const available = group.actions.filter((action) => grantable.includes(action));
            if (available.length === 0) return null;

            return (
              <fieldset key={group.label}>
                <legend className="mb-1.5 font-display text-sm text-cloud">{group.label}</legend>
                <div className="grid gap-1.5 sm:grid-cols-2">
                  {available.map((action) => (
                    <label key={action} className="flex items-start gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={selected.has(action)}
                        onChange={() => toggle(action)}
                        className="mt-0.5"
                      />
                      <span>{ACTION_LABELS[action]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            );
          })}
        </div>
      </div>

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={disabled || draft.name.trim().length < 2 || draft.actions.length === 0}
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition disabled:opacity-40"
        >
          {draft.roleId === undefined ? "Создать" : "Сохранить"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border px-4 py-2 text-sm text-muted-foreground transition hover:text-cloud"
        >
          Отмена
        </button>
      </div>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

function RoleCard({
  role,
  grants,
  candidates,
  heldBy,
  disabled,
  onEdit,
  onDelete,
  onGrant,
  onRevoke,
}: {
  role: CustomRoleRecord;
  grants: RoleGrantRecord[];
  candidates: ProfileRecord[];
  heldBy: (steamId: string) => boolean;
  disabled: boolean;
  onEdit: () => void;
  onDelete: () => void;
  /**
   * `done` is invoked only when the server reports a real change, and is the
   * card's cue to clear its tick boxes — see the note on `batch`.
   */
  onGrant: (steamIds: string[], done: () => void) => void;
  onRevoke: (steamIds: string[], done: () => void) => void;
}) {
  const [picked, setPicked] = useState<string[]>([]);
  const [showAll, setShowAll] = useState(false);

  function toggle(steamId: string) {
    setPicked((previous) =>
      previous.includes(steamId) ? previous.filter((id) => id !== steamId) : [...previous, steamId],
    );
  }

  // Which button does what, and which list feeds it.
  //
  // These two lists were the wrong way round, and the swap is not a cosmetic
  // mistake: "Выдать" was handed the people who ALREADY had the role, so ticking
  // a colleague and pressing it reported "уже была выдана" and changed nothing,
  // while "Снять" was handed the people who did NOT have it and silently did
  // nothing at all. Combined with the two not being loadable from the server on
  // mount — `grants` starts empty, so nobody looked like a holder — the result was
  // a picker where granting was impossible and revoking was a no-op that looked
  // like it worked.
  const toGrant = picked.filter((steamId) => !heldBy(steamId));
  const toRevoke = picked.filter((steamId) => heldBy(steamId));

  // How many of the people on the roster already hold this role.
  //
  // Counted from `grants`, which the parent has already narrowed to this role, and
  // not from the `heldBy` callback: that function is rebuilt on every render, so
  // it cannot be a hook dependency, and routing through it would mean either
  // recomputing on every render or suppressing the lint that was right to complain.
  // Nor is `role.holderCount` used, which is a stored total recomputed on the
  // server and would lag behind the list for a moment after every grant — exactly
  // when somebody is looking at it.
  const heldCount = useMemo(
    () => candidates.filter((profile) => grants.some((grant) => grant.steamId === profile.steamId)).length,
    [candidates, grants],
  );

  return (
    <Panel className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="font-display text-base text-cloud">{role.name}</h3>
            <Badge variant="secondary">{role.holderCount}</Badge>
          </div>
          {role.description && <p className="mt-1 text-sm text-muted-foreground">{role.description}</p>}
        </div>

        <div className="flex gap-2">
          <button type="button" onClick={onEdit} className="text-sm text-muted-foreground hover:text-cloud">
            Изменить
          </button>
          <button
            type="button"
            onClick={onDelete}
            disabled={disabled}
            className="inline-flex items-center gap-1 text-sm text-muted-foreground transition hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Удалить
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {role.actions.map((action) => (
          <Badge key={action} variant="outline">
            {ACTION_LABELS[action]}
          </Badge>
        ))}
      </div>

      {grants.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          {grants.map((grant) => grant.displayName).join(", ")}
        </p>
      ) : null}

      {candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">Нет одобренных участников.</p>
      ) : (
        <div className="space-y-2 border-t border-border pt-3">
          {/*
            The roster is behind a button rather than always open. Two reasons: an
            always-open scrolling box on every role card pushed the actual role
            list off the screen once there was more than a couple of roles, and a
            list of a hundred names that is always on display is noise rather than
            information — you only want it when you are about to hand something out.
            `showAll` is React state, so it is false on the server and false on the
            first client render alike, and the two agree.
          */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setShowAll((previous) => !previous)}
              aria-expanded={showAll}
              className="inline-flex items-center gap-1 rounded-lg border border-border px-3 py-1.5 text-xs text-cloud transition hover:border-primary"
            >
              {showAll ? "Скрыть список" : `Показать всех (${candidates.length})`}
            </button>
            {heldCount > 0 ? (
              <span className="text-xs text-muted-foreground">
                Роль у {heldCount} {plural(heldCount, "человека", "человек", "человек")}
              </span>
            ) : null}
          </div>

          {showAll ? (
            <div className="max-h-52 space-y-1 overflow-y-auto">
              {candidates.map((profile) => (
                <label key={profile.steamId} className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={picked.includes(profile.steamId)}
                    onChange={() => toggle(profile.steamId)}
                  />
                  <span className="flex-1 truncate">{profile.displayName}</span>
                  {heldBy(profile.steamId) ? <Badge variant="secondary">уже есть</Badge> : null}
                </label>
              ))}
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onGrant(toGrant, () => setPicked([]))}
              disabled={disabled || toGrant.length === 0}
              className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-primary hover:text-cloud disabled:opacity-40"
            >
              Выдать ({toGrant.length})
            </button>
            <button
              type="button"
              onClick={() => onRevoke(toRevoke, () => setPicked([]))}
              disabled={disabled || toRevoke.length === 0}
              className="rounded-lg border border-border px-3 py-1.5 text-xs transition hover:border-destructive hover:text-destructive disabled:opacity-40"
            >
              Снять ({toRevoke.length})
            </button>
          </div>
        </div>
      )}
    </Panel>
  );
}
