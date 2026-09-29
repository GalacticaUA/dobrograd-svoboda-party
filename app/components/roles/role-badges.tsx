"use client";

/**
 * A person's roles, as a stack of badges.
 *
 * The brief asked for `[Админ] [Модератор]` wherever a person is shown, and there
 * are five such places: the people table, the role editor, the registry card, the
 * account panel and the auth dialog. A stack drawn once and reused is the only way
 * they stay the same, and a single-role label in one of them is exactly the bug
 * this is here to prevent — a person who is both would otherwise read as an admin
 * on the registry and as a moderator in the panel, and nobody would know which was
 * true.
 *
 * The remove button is a prop rather than always drawn because the same stack is
 * used read-only, and a control that does nothing is worse than no control.
 */

import { X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { ROLE_LABEL, ROLE_MEANING } from "@/lib/role-labels";
import { hasRole, type Role } from "@/types/party";

/** Leader first, then the rest, then member. `normalizeRoles` already sorts. */
const VARIANT: Record<Role, "default" | "secondary" | "outline" | "destructive"> = {
  leader: "default",
  admin: "default",
  moderator: "secondary",
  member: "outline",
};

export function RoleBadges({
  roles,
  removable,
  onRemove,
  size = "sm",
}: {
  roles: readonly Role[];
  /** The roles this viewer may take away. Anything else gets no `×`. */
  removable?: readonly Role[];
  onRemove?: (role: Role) => void;
  size?: "sm" | "xs";
}) {
  const held = roles.length > 0 ? roles : (["member"] as Role[]);

  return (
    <span className="flex flex-wrap items-center gap-1">
      {held.map((role) => {
        const canRemove = onRemove !== undefined && (removable ?? []).includes(role);

        return (
          <span key={role} className="inline-flex items-center">
            <Badge
              variant={VARIANT[role]}
              title={ROLE_MEANING[role]}
              className={size === "xs" ? "text-[10px] leading-4" : undefined}
            >
              {ROLE_LABEL[role]}
            </Badge>

            {canRemove ? (
              <button
                type="button"
                onClick={() => onRemove?.(role)}
                // The badge says what it is; this says what the button does. A bare
                // `×` next to "Админ" is a mystery to a screen reader, and the
                // person most likely to press it is the one least likely to have
                // seen the tooltip.
                aria-label={`Снять роль «${ROLE_LABEL[role]}»`}
                title={`Снять роль «${ROLE_LABEL[role]}»`}
                className="-ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground transition hover:bg-destructive/20 hover:text-destructive"
              >
                <X className="h-3 w-3" aria-hidden />
              </button>
            ) : null}
          </span>
        );
      })}
    </span>
  );
}

/** True when a person holds a role, for a call site's own branching. */
export { hasRole };
