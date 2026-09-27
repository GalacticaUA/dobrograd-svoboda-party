"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { CalendarDays, Clock, CheckCheck, Hourglass } from "lucide-react";

import { EmptyState, LoadingBlock, Panel, StatTile } from "@/components/portal/primitives";
import { loadMyHours, loadEvents } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import type { EventWithAttendance, MyHours } from "@/lib/portal/types";

/**
 * The landing tab.
 *
 * Deliberately four numbers and the next event rather than a summary of all nine
 * tabs: the point of a dashboard is to answer "what needs me right now", and
 * anything more turns it into a second copy of the tab list.
 */
export function DashboardTab({ onOpenTab }: { onOpenTab: (tab: string) => void }) {
  const hours = useAsyncData<MyHours>(loadMyHours);
  const events = useAsyncData<EventWithAttendance[]>(loadEvents);
  const router = useRouter();

  if (hours.pending || events.pending) return <LoadingBlock />;

  if (hours.error) {
    return <EmptyState title="Не удалось загрузить сводку" hint={hours.error} />;
  }

  const my = hours.data;
  const upcoming = (events.data ?? [])
    .filter((event) => event.status === "open")
    .slice(0, 3);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile
          label="Часов отработано"
          value={(my?.totalHours ?? 0).toFixed(1)}
          hint="сумма по закрытым событиям"
        />
        <StatTile
          label="Мероприятий"
          value={String(my?.eventsAttended ?? 0)}
          hint="вы отработали"
        />
        <StatTile
          label="Пропущено"
          value={String(my?.eventsAbsent ?? 0)}
          hint="учтено как отсутствие"
        />
        <StatTile
          label="Записан"
          value={String(my?.upcomingCount ?? 0)}
          hint="на открытые события"
        />
      </div>

      <Panel>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-display text-base text-cloud">Ближайшие события</h3>
          <button
            type="button"
            onClick={() => onOpenTab("schedule")}
            className="text-xs text-primary hover:underline"
          >
            Всё расписание
          </button>
        </div>

        {upcoming.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Открытых мероприятий пока нет.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {upcoming.map((event) => (
              <li key={event.id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-cloud">{event.title}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span className="inline-flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {new Date(event.startsAt).toLocaleString("ru-RU", {
                        day: "numeric",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </span>
                    {event.location && <span className="truncate">{event.location}</span>}
                  </p>
                </div>
                {event.ownStatus === "rsvp" ? (
                  <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-primary/15 px-2 py-1 text-xs text-primary">
                    <CheckCheck className="h-3 w-3" />
                    вы идёте
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onOpenTab("schedule")}
                    className="shrink-0 rounded-lg border border-border px-2 py-1 text-xs text-cloud hover:border-primary"
                  >
                    Записаться
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <h3 className="mb-2 font-display text-base text-cloud">С чего начать</h3>
        <ul className="space-y-1.5 text-sm text-muted-foreground">
          <li className="flex items-start gap-2">
            <Hourglass className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <button type="button" onClick={() => onOpenTab("account")} className="text-left hover:text-cloud">
              Задайте имя персонажа и свой график - так вас проще позвать на сборы.
            </button>
          </li>
          <li className="flex items-start gap-2">
            <CheckCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <button type="button" onClick={() => onOpenTab("appeals")} className="text-left hover:text-cloud">
              Обращения и опросы партии видны только участникам.
            </button>
          </li>
          <li className="flex items-start gap-2">
            <CalendarDays className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
            <Link href="/admin" className="text-left hover:text-cloud">
              Очередь заявок на вступление
            </Link>
          </li>
        </ul>
        <button
          type="button"
          onClick={() => router.refresh()}
          className="mt-3 text-xs text-muted-foreground hover:text-cloud"
        >
          Обновить данные
        </button>
      </Panel>
    </div>
  );
}
