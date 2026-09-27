"use client";

import { useState, useTransition } from "react";
import { Download, ScrollText } from "lucide-react";


import { EmptyState, LoadingBlock, PageTitle, Panel, StatTile } from "@/components/portal/primitives";
import { loadAudit, loadRegistry } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { can } from "@/lib/permissions";
import { buildRegistryCsv, downloadCsv, registryCsvFilename } from "@/lib/csv";
import { displayNameOf, type AuditEntry, type RegistryEntry } from "@/lib/portal/types";
import type { ProfileDTO } from "@/types/auth";

const ACTION_LABELS: Record<string, string> = {
  "account.update": "изменил настройки аккаунта",
  "profile.setRole": "изменил роль участника",
  "event.create": "создал мероприятие",
  "event.update": "изменил мероприятие",
  "event.close": "закрыл мероприятие и записал часы",
  "event.editHours": "исправил часы после закрытия",
  "event.rsvp.join": "записался на мероприятие",
  "event.rsvp.leave": "отписался от мероприятия",
  "appeal.create": "создал обращение",
  "appeal.setStatus": "сменил статус обращения",
  "appeal.reply": "ответил на обращение",
  "appeal.deleteOwn": "удалил своё обращение",
  "appeal.deleteAny": "удалил обращение",
  "poll.create": "создал опрос",
  "poll.vote": "проголосовал",
  "poll.setStatus": "изменил статус опроса",
  "poll.deleteOwn": "удалил свой опрос",
  "poll.deleteAny": "удалил опрос",
  "point.create": "добавил точку на карту",
  "point.update": "изменил точку на карте",
  "point.delete": "удалил точку с карты",
};

/**
 * Reports and the audit trail.
 *
 * A member sees the same tab as everyone else, with the party-wide figures
 * replaced by their own. Two components would have meant two code paths to keep
 * in agreement, and the staff version leaking a phone number to a member is a bug
 * that only shows up once it has happened.
 */
export function ReportsTab({ profile }: { profile: ProfileDTO }) {
  const registry = useAsyncData<RegistryEntry[]>(loadRegistry);
  const isStaff = can(profile.role, "report.viewAll");

  if (registry.pending) return <LoadingBlock />;
  if (registry.error) {
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">{registry.error}</p>
        <button type="button" onClick={() => registry.refresh()} className="mt-3 text-sm text-primary hover:underline">
          Повторить
        </button>
      </Panel>
    );
  }

  const all = registry.data ?? [];
  const me = all.find((entry) => entry.steamId === profile.steamId);

  if (!isStaff) {
    return (
      <div className="space-y-4">
        <PageTitle title="Отчёты" sub="Ваша личная статистика." />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Часов" value={String(me?.totalHours ?? 0)} />
          <StatTile label="Мероприятий" value={String(me?.eventsAttended ?? 0)} />
          <StatTile label="Пропущено" value={String(me?.eventsAbsent ?? 0)} />
          <StatTile
            label="В партии с"
            value={
              me?.createdAt
                ? new Date(me.createdAt).toLocaleDateString("ru-RU", { month: "short", year: "numeric" })
                : "—"
            }
          />
        </div>
        <p className="text-sm text-muted-foreground">
          Сводные цифры по всей партии видны сотрудникам.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <PageTitle title="Отчёты" sub="Сводка по партии и журнал изменений." />
      <StaffReports rows={all} />
    </div>
  );
}

function StaffReports({ rows }: { rows: RegistryEntry[] }) {
  const [exporting, startExport] = useTransition();
  const [entityFilter, setEntityFilter] = useState("all");

  const totalHours = rows.reduce((sum, entry) => sum + entry.totalHours, 0);
  // Deliberately not `useMemo`: this is a sort of at most a few hundred rows over
  // a list that only changes when the registry is refetched, and the React
  // Compiler already memoises it. An explicit `useMemo` here only risks the
  // compiler flagging a "memoization could not be preserved" bailout.
  const top = rows
    .filter((entry) => entry.totalHours > 0)
    .sort((a, b) => b.totalHours - a.totalHours)
    .slice(0, 5);
  const maxHours = Math.max(1, ...top.map((entry) => entry.totalHours));

  const exportCsv = () => {
    startExport(async () => {
      // Reuses the shared CSV builder, so the registry export gets the same UTF-8
      // BOM, semicolon delimiter and formula-injection guard as the applications
      // export rather than a second, slightly different implementation.
      const csv = buildRegistryCsv(
        rows.map((entry) => ({
          name: displayNameOf(entry),
          persona: entry.persona,
          steamId: entry.steamId,
          role: entry.role,
          status: entry.status,
          totalHours: entry.totalHours,
          eventsAttended: entry.eventsAttended,
          eventsAbsent: entry.eventsAbsent,
          telegram: entry.telegram,
          discord: entry.discord,
          phone: entry.phone,
          about: entry.about,
          createdAt: entry.createdAt.slice(0, 10),
        })),
      );
      downloadCsv(csv, registryCsvFilename());
    });
  };

  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Всего часов" value={totalHours.toFixed(1)} />
        <StatTile label="Участников" value={String(rows.length)} />
        <StatTile
          label="С часами"
          value={String(rows.filter((entry) => entry.totalHours > 0).length)}
        />
        <StatTile
          label="Средний час"
          value={
            rows.length ? (totalHours / rows.length).toFixed(1) : "0"
          }
        />
      </div>

      <Panel>
        <div className="mb-3 flex items-center justify-between gap-3">
          <h3 className="font-display text-base text-cloud">Кто больше всех отработал</h3>
          <button
            type="button"
            onClick={exportCsv}
            disabled={exporting}
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud disabled:opacity-60"
          >
            <Download className="h-3.5 w-3.5" />
            CSV
          </button>
        </div>

        {top.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Пока никто не отработал ни одного мероприятия.
          </p>
        ) : (
          <ul className="space-y-2">
            {top.map((entry) => (
              <li key={entry.steamId} className="flex items-center gap-3">
                <span className="w-32 shrink-0 truncate text-sm text-clock sm:w-48">
                  {displayNameOf(entry)}
                </span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-background">
                  <span
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${(entry.totalHours / maxHours) * 100}%` }}
                  />
                </span>
                <span className="w-16 shrink-0 text-right text-xs text-muted-foreground">
                  {entry.totalHours} ч
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <AuditTrail filter={entityFilter} onFilterChange={setEntityFilter} />
    </>
  );
}

function AuditTrail({
  filter,
  onFilterChange,
}: {
  filter: string;
  onFilterChange: (value: string) => void;
}) {
  const { data, error, pending, refresh } = useAsyncData<AuditEntry[]>(loadAudit);

  if (pending) return <LoadingBlock label="Читаем журнал…" />;
  if (error) {
    // Rendered inline rather than pushed to a toast from the render body: a toast
    // fired during render is a side effect React may run more than once.
    return (
      <Panel>
        <h3 className="mb-2 flex items-center gap-2 font-display text-base text-cloud">
          <ScrollText className="h-4 w-4 text-primary" />
          Журнал действий
        </h3>
        <p className="text-sm text-muted-foreground">{error}</p>
        <button type="button" onClick={() => refresh()} className="mt-3 text-sm text-primary hover:underline">
          Повторить
        </button>
      </Panel>
    );
  }

  const entries = data ?? [];
  const entities = [...new Set(entries.map((entry) => entry.entity))].sort();
  const shown = filter === "all" ? entries : entries.filter((entry) => entry.entity === filter);

  if (entries.length === 0) {
    return (
      <Panel>
        <h3 className="mb-2 flex items-center gap-2 font-display text-base text-cloud">
          <ScrollText className="h-4 w-4 text-primary" />
          Журнал действий
        </h3>
        <EmptyState title="Журнал пуст" hint="Здесь появится каждое изменение: роли, часы, удаления." />
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 font-display text-base text-cloud">
          <ScrollText className="h-4 w-4 text-primary" />
          Журнал действий
        </h3>
        <select
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-clock outline-none focus:border-primary"
        >
          <option value="all">Все разделы</option>
          {entities.map((entity) => (
            <option key={entity} value={entity}>
              {entity}
            </option>
          ))}
        </select>
      </div>

      <ul className="divide-y divide-border">
        {shown.slice(0, 50).map((entry) => (
          <li key={entry.id} className="py-2 text-sm">
            <p className="text-clock">
              <span className="font-medium">{entry.actorName}</span>{" "}
              <span className="text-muted-foreground">
                {ACTION_LABELS[entry.action] ?? entry.action}
              </span>
            </p>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {new Date(entry.createdAt).toLocaleString("ru-RU", {
                day: "numeric",
                month: "short",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {entry.entityId ? ` · ${entry.entity}#${entry.entityId}` : ""}
            </p>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
