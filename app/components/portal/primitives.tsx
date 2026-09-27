import type { ReactNode } from "react";
import { Lock } from "lucide-react";

import { cn } from "@/lib/utils";
import { can, type Action } from "@/lib/permissions";
import type { Role } from "@/types/party";

/**
 * Shared presentation pieces for the portal.
 *
 * No `"use client"` here on purpose: these are pure presentational components, so
 * they can be rendered from a server component as happily as from a client tab.
 * Anything that needs state or an action lives in the tab components instead.
 *
 * The previous version of this file read the caller's role out of a
 * `PortalProvider` context, which was a `useState` mock holding hard-coded data
 * and defaulting to `leader`. Authorisation now flows from the real session
 * through `can()` in app/lib/permissions.ts, so the role is passed in explicitly
 * and there is no second source of truth left to disagree with the database.
 */

export function PageTitle({
  title,
  sub,
  action,
}: {
  title: string;
  sub?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h2 className="font-display text-xl font-bold text-cloud sm:text-2xl">{title}</h2>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-border bg-card p-4 sm:p-5", className)}>{children}</div>;
}

export const fieldCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-cloud outline-none transition focus:border-primary";

/** Consistent "there is nothing here yet" state, so empty lists do not look broken. */
export function EmptyState({
  title,
  hint,
  action,
}: {
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-border bg-card/40 px-6 py-12 text-center">
      <p className="font-display text-base text-cloud">{title}</p>
      {hint && <p className="max-w-sm text-sm text-muted-foreground">{hint}</p>}
      {action}
    </div>
  );
}

export function LoadingBlock({ label = "Загрузка…" }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 rounded-2xl border border-border bg-card px-6 py-12 text-sm text-muted-foreground">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-primary" />
      {label}
    </div>
  );
}

/**
 * Explain a refusal instead of rendering nothing.
 *
 * Used by tabs whose whole content is staff-only. A tab that silently renders
 * empty when the viewer lacks the role is indistinguishable from a bug, so the
 * viewer is told plainly what happened.
 */
export function StaffOnly({
  role,
  action,
  children,
}: {
  role: Role;
  action: Action;
  children: ReactNode;
}) {
  if (can(role, action)) return <>{children}</>;

  return (
    <Panel className="flex flex-col items-center gap-3 py-14 text-center">
      <Lock className="h-7 w-7 text-muted-foreground" />
      <p className="font-display text-lg text-cloud">Раздел доступен сотрудникам</p>
      <p className="text-sm text-muted-foreground">
        Эта вкладка доступна только администраторам и лидеру партии.
      </p>
    </Panel>
  );
}

/** Four numbers for the dashboard. */
export function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-2xl font-bold text-cloud">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
