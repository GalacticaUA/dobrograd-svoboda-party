"use client";

import { useState } from "react";
import {
  BarChart3,
  CalendarDays,
  LayoutDashboard,
  Map,
  MessageSquare,
  Settings2,
  Shield,
  Users,
  Vote,
  type LucideIcon,
} from "lucide-react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { can, type Action } from "@/lib/permissions";
import { AccountTab } from "@/components/portal/tabs/account";
import { AppealsTab } from "@/components/portal/tabs/appeals";
import { AvailabilityTab } from "@/components/portal/tabs/availability";
import { DashboardTab } from "@/components/portal/tabs/dashboard";
import { ManagementTab } from "@/components/portal/tabs/management";
import { PollsTab } from "@/components/portal/tabs/polls";
import { RegistryTab } from "@/components/portal/tabs/registry";
import { ReportsTab } from "@/components/portal/tabs/reports";
import { ScheduleTab } from "@/components/portal/tabs/schedule";
import { WorkMapTab } from "@/components/portal/tabs/work-map";
import type { ProfileDTO } from "@/types/auth";

/**
 * The portal, in one modal.
 *
 * Layout is a rail of tabs on the left for pointer-sized screens and a scrolling
 * strip of tabs at the bottom on a phone. Both render the *same* tab list from the
 * same registry, so a permission change moves a tab out of both at once and the
 * two can never disagree about what exists.
 *
 * The two layouts are not cosmetic. On a phone, `100dvh` is used instead of
 * `100vh` because `100vh` on iOS Safari is the height of the viewport *with the
 * collapsing address bar hidden*, which puts the bottom tab strip permanently
 * underneath the browser's own toolbar. The safe-area padding on that strip is
 * for the same reason: on a notched phone the home indicator would otherwise sit
 * on top of the tabs.
 *
 * Tabs are mounted by key rather than kept alive, so switching away from a
 * half-filled form and back does not silently lose what was typed, and no tab
 * keeps stale data from a previous render pass.
 */

interface TabDef {
  id: string;
  label: string;
  short: string;
  icon: LucideIcon;
  /** Which permission reveals this tab. Omit for tabs every member may open. */
  action?: Action;
}

const TABS: TabDef[] = [
  { id: "dashboard", label: "Сводка", short: "Сводка", icon: LayoutDashboard },
  { id: "schedule", label: "Расписание", short: "Распис.", icon: CalendarDays },
  { id: "map", label: "Карта работ", short: "Карта", icon: Map },
  { id: "appeals", label: "Обращения", short: "Обращ.", icon: MessageSquare },
  { id: "polls", label: "Опросы", short: "Опросы", icon: Vote },
  { id: "registry", label: "Реестр", short: "Реестр", icon: Users },
  { id: "reports", label: "Отчёты", short: "Отчёты", icon: BarChart3 },
  { id: "availability", label: "График", short: "График", icon: CalendarDays },
  { id: "account", label: "Аккаунт", short: "Аккаунт", icon: Settings2 },
  { id: "management", label: "Управление", short: "Управл.", icon: Shield, action: "application.review" },
];

export function PortalDialog({
  open,
  onOpenChange,
  profile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  profile: ProfileDTO;
}) {
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("dashboard");

  const visible = TABS.filter((entry) => !entry.action || can(profile.role, entry.action));

  // If a permission is revoked while the modal is open, `tab` may name a tab that no
  // longer exists. Rather than syncing `tab` back in an effect, the fallback is
  // applied during render: the first visible tab is shown, and `active` is always
  // defined, so there is no frame in which the dialog body is blank. Resetting the
  // stored id in an effect would also mean a second render pass for something the
  // derived value already handles.
  const active = visible.find((entry) => entry.id === tab) ?? visible[0];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={
          // The shared DialogContent is a centred `grid` with `gap-4 p-6`. Only
          // `gap`/`padding` are overridden here - `display` is deliberately not
          // overridden with `flex`, because `grid` and `flex` are the same Tailwind
          // property and the winner is decided by stylesheet order, not by the
          // order of the class names. The layout below is therefore a single child
          // that owns the flexing.
          isMobile
            ? "h-[100dvh] w-full max-w-none gap-0 overflow-hidden rounded-none border-0 p-0 sm:rounded-none"
            : "h-[88vh] max-w-6xl gap-0 overflow-hidden p-0"
        }
      >
        <DialogTitle className="sr-only">Портал партии «Свобода»</DialogTitle>

        {/*
          `min-w-0` here is load-bearing and must not be removed.
          This row is the single grid item of `DialogContent`, whose track is
          `auto`. A grid item's automatic minimum size is its *min-content* size,
          and min-content flows all the way down to the widest thing in the tab -
          for the map tab, the zoomed map image, which is deliberately wider than
          the panel. Without this the track grew to fit that image, the whole
          column below it was stretched to the new width, and the map's rounded
          frame grew with the page instead of scrolling inside itself.
          `min-w-0` breaks that chain: the track stays at the dialog's width, and
          oversized content is confined to its own `overflow` container.
        */}
        <div className="flex h-full min-h-0 min-w-0 flex-col md:flex-row">
          {/* Desktop rail */}
          <nav className="hidden shrink-0 flex-col gap-1 overflow-y-auto border-r border-border p-3 md:flex md:w-52">
            <p className="px-2 pb-2 font-display text-sm font-bold text-cloud">Портал</p>
            {visible.map((entry) => (
              <TabButton key={entry.id} entry={entry} active={entry.id === active?.id} onSelect={setTab} />
            ))}
          </nav>

          {/* Content column */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {/* `pr-10` reserves room for the shared DialogContent's own close
                button, which is positioned against the dialog and not this row. */}
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-3 pr-10">
              <h2 className="truncate font-display text-base font-bold text-cloud">
                {active?.label ?? "Портал"}
              </h2>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto p-4">
              {active && (
                <div key={active.id}>
                  <TabBody tab={active.id} profile={profile} onOpenTab={setTab} />
                </div>
              )}
            </div>

            {/* Phone tab strip */}
            <nav
              className="flex shrink-0 gap-1 overflow-x-auto border-t border-border p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden"
              style={{ WebkitOverflowScrolling: "touch" }}
            >
              {visible.map((entry) => (
                <TabButton
                  key={entry.id}
                  entry={entry}
                  active={entry.id === active?.id}
                  onSelect={setTab}
                  compact
                />
              ))}
            </nav>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function TabButton({
  entry,
  active,
  onSelect,
  compact,
}: {
  entry: TabDef;
  active: boolean;
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  const Icon = entry.icon;

  if (compact) {
    return (
      <button
        type="button"
        onClick={() => onSelect(entry.id)}
        aria-current={active ? "page" : undefined}
        className={`flex min-w-[4.25rem] shrink-0 flex-col items-center gap-1 rounded-xl px-2 py-1.5 text-[0.65rem] transition ${
          active ? "bg-primary/15 text-primary" : "text-muted-foreground"
        }`}
      >
        <Icon className="h-4 w-4" />
        <span className="truncate">{entry.short}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onSelect(entry.id)}
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm transition ${
        active ? "bg-primary/15 text-primary" : "text-muted-foreground hover:bg-accent hover:text-cloud"
      }`}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="truncate">{entry.label}</span>
    </button>
  );
}

function TabBody({
  tab,
  profile,
  onOpenTab,
}: {
  tab: string;
  profile: ProfileDTO;
  onOpenTab: (id: string) => void;
}) {
  switch (tab) {
    case "dashboard":
      return <DashboardTab onOpenTab={onOpenTab} />;
    case "schedule":
      return <ScheduleTab profile={profile} />;
    case "map":
      return <WorkMapTab profile={profile} />;
    case "appeals":
      return <AppealsTab profile={profile} />;
    case "polls":
      return <PollsTab profile={profile} />;
    case "registry":
      return <RegistryTab profile={profile} />;
    case "reports":
      return <ReportsTab profile={profile} />;
    case "availability":
      return <AvailabilityTab role={profile.role} />;
    case "account":
      return <AccountTab />;
    case "management":
      return <ManagementTab profile={profile} />;
    default:
      return null;
  }
}
