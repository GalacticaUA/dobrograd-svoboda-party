"use client";

/**
 * "Show everybody" for one built-in role: a dialog, two columns, one click each way.
 *
 * The brief asked for exactly this shape, and the shape is the point. The people
 * table edits one person at a time, which is right for a correction and wrong for
 * handing a role out to a committee — for that you want to see the whole party in
 * one place, see who already has it, and click.
 *
 *   - Left: every member, with a tick on the ones who already hold the role.
 *     Clicking a row grants it. A row that is already ticked does nothing on click:
 *     taking the role away is offered on the right, where the button says so, so a
 *     single click in one column never has two meanings.
 *   - Right: the current holders, each with an explicit "Забрать роль".
 *
 * A fixed height with `overflow-y-auto` rather than the list growing to its
 * content: a party of four hundred would push the dialog off the screen, and a
 * dialog that scrolls with the list is a dialog nobody can act in.
 *
 * Everything is read from and written to the shared store, so granting here moves
 * the badge in the people table on the same tick, and a leader granted here
 * disappears from this right-hand column immediately — the row on the left that
 * held the title updates too, which is the only way a transfer can look like one
 * operation.
 */

import { useMemo, useState, useTransition } from "react";
import { Check, Users } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { ROLE_LABEL, ROLE_MEANING } from "@/lib/role-labels";
import { useRoleOptions, useRolesStore } from "@/components/roles/roles-store";
import type { Role } from "@/types/party";

/** The roles this dialog can be opened for. `member` is the absence of the rest. */
const OFFERED: readonly Role[] = ["leader", "admin", "moderator"];

/**
 * Roles the editor may look at but not hand out.
 *
 * `admin` belongs here because somebody has to be able to see who holds it — that
 * is the list you need when somebody leaves — and because the role editor would
 * otherwise have a row that says "Админ" with no way to act on it and no
 * explanation. It is granted by hand in the database, so the dialog for it opens
 * read-only: the right-hand column has no button, and the left-hand column is not
 * clickable. A button that always refuses is worse than no button.
 */
const READ_ONLY: readonly Role[] = ["admin"];

export function BuiltInRoleSection({ viewerRoles }: { viewerRoles: readonly Role[] }) {
  const [openFor, setOpenFor] = useState<Role | null>(null);
  const store = useRolesStore();

  return (
    <>
      <div className="space-y-2">
        {OFFERED.map((role) => {
          const readOnly = READ_ONLY.includes(role);

          return (
            <div
              key={role}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-display text-base text-cloud">{ROLE_LABEL[role]}</h3>
                  <Badge variant="secondary">{store.holdersWith(role).length}</Badge>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">{ROLE_MEANING[role]}</p>
              </div>

              <div className="flex items-center gap-2">
                {readOnly ? (
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    только просмотр
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setOpenFor(role)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-cloud transition hover:border-primary hover:text-primary"
                >
                  <Users className="h-3.5 w-3.5" aria-hidden />
                  Показать всех
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {openFor === null ? null : (
        <RoleMembersDialog
          role={openFor}
          viewerRoles={viewerRoles}
          onOpenChange={(next) => {
            if (!next) setOpenFor(null);
          }}
        />
      )}
    </>
  );
}

function RoleMembersDialog({
  role,
  viewerRoles,
  onOpenChange,
}: {
  role: Role;
  viewerRoles: readonly Role[];
  onOpenChange: (open: boolean) => void;
}) {
  const store = useRolesStore();
  const { addable, removable } = useRoleOptions(viewerRoles);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const readOnly = READ_ONLY.includes(role);

  /**
   * Everybody the store has been told about, pending accounts included.
   *
   * Approved only for the *grant* side, because a pending account holding a role
   * is a role nobody can use — `requireSession` refuses them — and offering it
   * would be offering a no-op. The revoke side still lists them, since somebody
   * may have been promoted and then not approved, and the badge has to be
   * removable.
   */
  const people = useMemo(
    () => [...store.holders].sort((a, b) => a.displayName.localeCompare(b.displayName, "ru")),
    [store.holders],
  );

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-card sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-display text-xl text-cloud">
            {ROLE_LABEL[role]} — все участники
          </DialogTitle>
          <DialogDescription>
            {readOnly
              ? `Кто сейчас держит «${ROLE_LABEL[role]}». Эта роль выдаётся напрямую в базе данных, поэтому здесь её можно только посмотреть.`
              : `Слева все, кто зарегистрирован. Отметка стоит у тех, у кого роль уже есть. Справа — текущие назначения.`}
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[60vh] grid-cols-1 gap-4 overflow-y-auto sm:grid-cols-2">
          <section className="flex min-h-0 flex-col">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              Все участники ({people.length})
            </h3>

            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {people.length === 0 ? (
                <p className="text-sm text-muted-foreground">Список пуст.</p>
              ) : (
                people.map((person) => {
                  const has = store.rolesOf(person.steamId).includes(role);
                  // Three separate reasons a row cannot be clicked, and the title
                  // says which: already theirs, not approved yet, or the party-wide
                  // rule says no (the last appointable person, say). Anything else
                  // and a click would come back as a refusal.
                  const approved = person.status === "approved";
                  const canTake = approved && addable(person.steamId).includes(role);
                  const busy = busyId === person.steamId;
                  const reason = has
                    ? `Роль «${ROLE_LABEL[role]}» уже есть`
                    : readOnly
                      ? `Роль «${ROLE_LABEL[role]}» выдаётся напрямую в базе данных`
                      : !approved
                        ? "Сначала одобрите участника"
                        : !canTake
                          ? `Сейчас нельзя выдать «${ROLE_LABEL[role]}»`
                          : `Назначить «${ROLE_LABEL[role]}»`;

                  return (
                    <button
                      key={person.steamId}
                      type="button"
                      // Already holding it: the row is a fact, not an action, so it
                      // is not a button at all. Making it one would mean a click
                      // that does nothing, which reads as a broken app.
                      disabled={readOnly || has || !canTake || busy}
                      onClick={() => {
                        setBusyId(person.steamId);
                        startTransition(async () => {
                          await store.add(person.steamId, role);
                          setBusyId(null);
                        });
                      }}
                      title={reason}
                      className="flex w-full items-center gap-2 rounded-lg border border-border/60 px-3 py-2 text-left text-sm text-cloud transition enabled:hover:border-primary/60 enabled:hover:bg-primary/5 disabled:opacity-70"
                    >
                      <span
                        aria-hidden
                        className="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-border"
                      >
                        {has ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                      </span>

                      <span className="min-w-0 flex-1 truncate">{person.displayName}</span>

                      {person.status !== "approved" ? (
                        <span className="text-[10px] uppercase text-amber-400">ждёт</span>
                      ) : null}
                    </button>
                  );
                })
              )}
            </div>
          </section>

          <section className="flex min-h-0 flex-col">
            <h3 className="mb-2 text-xs uppercase tracking-wide text-muted-foreground">
              С этой ролью ({store.holdersWith(role).length})
            </h3>

            <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
              {store.holdersWith(role).length === 0 ? (
                <p className="text-sm text-muted-foreground">Никого.</p>
              ) : (
                store.holdersWith(role).map((person) => {
                  // Same question as the left column, asked the other way round.
                  // The last leader cannot be stripped of the title, an admin
                  // cannot be demoted from here at all, and a viewer who cannot
                  // appoint cannot revoke either — so the button appears only where
                  // the server would actually accept the click.
                  const canDrop = !readOnly && removable(person.steamId).includes(role);
                  const busy = busyId === person.steamId;

                  return (
                    <div
                      key={person.steamId}
                      className="flex items-center gap-2 rounded-lg border border-border/60 px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-cloud">
                        {person.displayName}
                      </span>

                      {canDrop ? (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setBusyId(person.steamId);
                            startTransition(async () => {
                              await store.remove(person.steamId, role);
                              setBusyId(null);
                            });
                          }}
                          className="shrink-0 rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground transition hover:border-destructive/60 hover:text-destructive disabled:opacity-40"
                        >
                          Забрать роль
                        </button>
                      ) : (
                        <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground">
                          {readOnly ? "в базе" : "нельзя"}
                        </span>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}
