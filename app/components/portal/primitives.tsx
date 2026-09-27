"use client";

import type { ReactNode } from "react";
import { Lock } from "lucide-react";
import { isStaff, usePortal } from "@/hooks/usePortal";
import { cn } from "@/lib/utils";

export function PageTitle({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="font-display text-2xl font-bold text-cloud sm:text-3xl">{title}</h1>
        {sub && <p className="mt-1 text-sm text-muted-foreground">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl border border-border bg-card p-5", className)}>{children}</div>;
}

export function StaffOnly({ children }: { children: ReactNode }) {
  const { role } = usePortal();
  if (isStaff(role)) return <>{children}</>;
  return (
    <Panel className="flex flex-col items-center gap-3 py-16 text-center">
      <Lock className="h-8 w-8 text-muted-foreground" />
      <p className="font-display text-lg text-cloud">Доступ ограничен</p>
      <p className="text-sm text-muted-foreground">Раздел доступен только Лидеру и Администраторам.</p>
    </Panel>
  );
}

export const fieldCls =
  "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-cloud outline-none transition focus:border-primary";
