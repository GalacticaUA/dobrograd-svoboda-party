"use client";

import { useState, useTransition } from "react";
import { ChevronDown, ChevronUp, Download, ScrollText } from "lucide-react";

import { EmptyState, LoadingBlock, PageTitle, Panel, StatTile } from "@/components/portal/primitives";
import { loadAudit, loadRegistry } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { buildRegistryCsv, downloadCsv, joinRoleLabels, registryCsvFilename } from "@/lib/csv";
import { ROLE_LABEL } from "@/lib/role-labels";
import { cn } from "@/lib/utils";
import { displayNameOf, type AuditEntry, type RegistryEntry } from "@/lib/portal/types";
import type { Role } from "@/types/party";
import type { ProfileDTO } from "@/types/auth";
import { useCan } from "@/components/portal/permissions";

/**
 * Fallback verbs, for actions this component has no specific description for.
 *
 * The first half of a two-part contract: `describeAudit` produces a precise,
 * contextual sentence whenever the audit row carries enough metadata, and this
 * map catches the rest so that an action nobody has written a formatter for still
 * reads as Russian rather than as an enum value.
 */
const ACTION_LABELS: Record<string, string> = {
  "account.update": "изменил настройки аккаунта",
  "event.create": "создал мероприятие",
  "event.update": "изменил мероприятие",
  "event.close": "закрыл мероприятие и записал часы",
  "event.editHours": "исправил часы после закрытия",
  "event.restore": "восстановил мероприятие",
  "event.rsvp.join": "записался на мероприятие",
  "event.rsvp.leave": "отписался от мероприятия",
  "event.deleteAny": "удалил мероприятие",
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
  "point.deleteAny": "удалил точку с карты",
  "profile.editAny": "изменил профиль участника",
  "profile.remove": "исключил участника",
  "hours.adjust": "скорректировал часы",
  "hours.adjust.delete": "отменил корректировку часов",
  "role.create": "создал роль",
  "role.update": "изменил роль",
  "role.delete": "удалил роль",
  "role.grant": "выдал роль",
  "role.revoke": "снял роль",
};

/**
 * Table names, in Russian.
 *
 * Used for the filter dropdown, which was offering the same raw identifiers as the
 * log rows did - `profile_role_assignments` is not a section a moderator should
 * have to recognise.
 */
const ENTITY_LABELS: Record<string, string> = {
  profiles: "Участники",
  profile_role_assignments: "Роли участников",
  profile_role_grants: "Пользовательские роли",
  party_events: "Мероприятия",
  appeals: "Обращения",
  polls: "Опросы",
  work_points: "Точки на карте",
  member_hours_adjustments: "Часы",
  custom_roles: "Настройка ролей",
};

const APPROVAL_LABELS: Record<string, string> = {
  pending: "Ожидает",
  approved: "Утверждён",
  rejected: "Отклонён",
};

/**
 * Details longer than this get a "показать детали" control.
 *
 * A heuristic rather than a measurement: the precise version needs a ResizeObserver
 * per row, purely to find out whether a block of text happens to exceed three lines
 * at the current width. At 220 characters a row is already visibly over three lines
 * on a phone and visibly under on a desktop, and being slightly eager costs one
 * extra click.
 */
const DETAIL_EXPAND_THRESHOLD = 220;

/* -------------------------------------------------------------------------- */
/* Turning an audit row into a sentence                                       */
/* -------------------------------------------------------------------------- */
/*
 * An audit row is a fact about the database: an action enum, a table name, an id
 * and a free-form `meta` blob whose shape is decided independently by each of the
 * thirty-odd call sites that write it. Rendering it raw produced lines like
 *
 *     Райан Хасл изменил роль участника · profile_role_assignments#76561198976975969
 *
 * which names a table, an identifier, and not the person, the role, or what
 * changed. Everything below exists to turn that back into a sentence.
 *
 * The contract with `meta` is deliberately read defensively. It is `jsonb`, it is
 * written by code that predates this reader, and rows written before a field was
 * added simply do not have it - so every accessor below returns `null` rather than
 * throwing, and every formatter degrades to a readable general label instead of
 * breaking. A missing detail must never cost the reader the whole entry.
 */

/** Reads a string out of the metadata blob, or null if it is absent or not one. */
function metaText(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function metaNumber(meta: Record<string, unknown>, key: string): number | null {
  const value = meta[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metaFlag(meta: Record<string, unknown>, key: string): boolean {
  return meta[key] === true;
}

function metaTexts(meta: Record<string, unknown>, key: string): string[] {
  const value = meta[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item !== "");
}

/**
 * Reads a `from`/`to` pair that holds role names.
 *
 * Returns null - rather than an empty list - when the value is not a role array at
 * all, because `profile.setRole` is also used to record an approval change, and
 * that path writes `{ from: { status }, to: { status } }`. Treating those objects as
 * role lists would silently produce "no roles were added, none removed" for what was
 * actually a status change.
 */
function roleListOf(value: unknown): Role[] | null {
  if (!Array.isArray(value)) return null;
  return value.filter((item): item is Role => typeof item === "string" && item in ROLE_LABEL);
}

/** The `status` field of a `{ from, to }` pair, when that is what the pair holds. */
function statusOf(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const status = (value as { status?: unknown }).status;
  return typeof status === "string" ? status : null;
}

const roleListText = (roles: Role[]) => roles.map((role) => ROLE_LABEL[role]).join(", ");

function joinWithAnd(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} и ${items[items.length - 1]}`;
}

/** One rendered audit line: the verb, plus the context that goes underneath it. */
interface AuditDescription {
  /** Sits immediately after the actor's name, in the accent colour. */
  action: string;
  /**
   * Secondary lines. Kept separate from the verb on purpose: "выдал роль" and
   * "Модератор" and "Иван Иванов" are three different pieces of information, and
   * running them together in one string is what produces the over-long lines that
   * then have to be truncated.
   */
  details: string[];
  /** True when there is enough text here to be worth an expand control. */
  expandable: boolean;
}

/**
 * Does this string look like an identifier rather than a name?
 *
 * Applied only to the *actor* name, which is the one field here that is a real
 * name when the lookup succeeds: the DAL resolves it server-side and falls back to
 * the raw account id when the profile is missing, so an unchecked `actorName` is
 * itself a raw identifier.
 *
 * It is deliberately not used to filter the id lookups. `entity_id` holds a Steam
 * account id for `profile.*` rows, a UUID for `event.*`, and a plain integer for
 * some tables - a pattern covering all three would be a guess, and a guess that is
 * wrong puts `Участник: 991` on the screen. Those lookups are registry-only
 * instead.
 */
function looksLikeIdentifier(value: string): boolean {
  return (
    /^\d{17}$/.test(value) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function describeAudit(
  entry: AuditEntry,
  /** Steam id to display name, or null when the member is not in the registry. */
  nameOf: (steamId: string | null) => string | null,
): AuditDescription {
  const { action, entityId, meta } = entry;

  const done = (verb: string, details: string[]): AuditDescription => {
    const lines = details.filter((line) => line !== "");
    return {
      action: verb,
      details: lines,
      expandable: lines.join(" ").length > DETAIL_EXPAND_THRESHOLD,
    };
  };

  /**
   * The member an action was aimed at.
   *
   * Null - and therefore simply omitted - rather than falling back to the id: a
   * removed member has no name to show, and the alternative was printing their
   * seventeen-digit account id in the log. An entry with no target line still reads
   * correctly; an entry with a raw id does not.
   */
  const target = nameOf(entityId);
  const withTarget = (verb: string, ...rest: string[]) =>
    done(verb, [target ? `Участник: ${target}` : "", ...rest]);

  switch (action) {
    /* --- Roles ---------------------------------------------------------- */

    case "profile.setRole": {
      const fromRoles = roleListOf(meta.from);
      const toRoles = roleListOf(meta.to);

      if (fromRoles && toRoles) {
        const added = toRoles.filter((role) => !fromRoles.includes(role));
        const removed = fromRoles.filter((role) => !toRoles.includes(role));

        if (added.length === 1 && removed.length === 0) {
          return withTarget(`выдал роль «${ROLE_LABEL[added[0]]}»`);
        }
        if (removed.length === 1 && added.length === 0) {
          return withTarget(`снял роль «${ROLE_LABEL[removed[0]]}»`);
        }
        if (added.length > 0 || removed.length > 0) {
          return withTarget(
            "изменил роли участника",
            added.length > 0 ? `Выдал: ${roleListText(added)}` : "",
            removed.length > 0 ? `Снял: ${roleListText(removed)}` : "",
            `Было: ${roleListText(fromRoles)}`,
            `Стало: ${roleListText(toRoles)}`,
          );
        }

        // The sets are identical, so nothing was really granted or revoked.
        return withTarget("изменил роли участника", `Роли прежние: ${roleListText(fromRoles)}`);
      }

      // The other shape this action carries: an approval change.
      const fromStatus = statusOf(meta.from);
      const toStatus = statusOf(meta.to);
      if (fromStatus && toStatus) {
        return withTarget(
          "изменил статус участника",
          `Было: ${APPROVAL_LABELS[fromStatus] ?? fromStatus}`,
          `Стало: ${APPROVAL_LABELS[toStatus] ?? toStatus}`,
        );
      }

      return withTarget("изменил роль участника");
    }

    case "profile.editAny": {
      // `from`/`to` here hold a single field, not a role list - so a different
      // reader from the one above, and the reason `roleListOf` returns null.
      const readName = (side: unknown) => {
        if (!side || typeof side !== "object") return null;
        const value = (side as { displayName?: unknown }).displayName;
        return typeof value === "string" && value !== "" ? value : null;
      };

      const before = readName(meta.from);
      const after = readName(meta.to);
      if (before !== null || after !== null) {
        return withTarget("изменил профиль участника", `Имя: ${before ?? "—"} → ${after ?? "—"}`);
      }
      return withTarget("изменил профиль участника");
    }

    case "profile.remove": {
      const roles = roleListOf(meta.from && typeof meta.from === "object" ? (meta.from as Record<string, unknown>).roles : null);
      const status = statusOf(meta.from);
      return withTarget(
        "исключил участника",
        roles ? `Роли: ${roleListText(roles)}` : "",
        status ? `Статус: ${APPROVAL_LABELS[status] ?? status}` : "",
        metaText(meta, "reason") ? `Причина: ${metaText(meta, "reason")}` : "",
      );
    }

    case "role.create":
    case "role.update": {
      const name = metaText(meta, "name") ?? metaText(meta, "key");
      return done(
        action === "role.create" ? "создал роль" : "изменил роль",
        [name ? `Название: ${name}` : "", metaTexts(meta, "actions").length > 0
          ? `Права: ${metaTexts(meta, "actions").length}`
          : ""],
      );
    }

    case "role.delete": {
      const key = metaText(meta, "key");
      return done("удалил роль", [key ? `Название: ${key}` : ""]);
    }

    case "role.grant":
    case "role.revoke": {
      const key = metaText(meta, "roleKey");
      const names = metaTexts(meta, "steamIds").map(nameOf).filter((name): name is string => name !== null);
      const count = metaNumber(meta, "count") ?? names.length;

      const verb = action === "role.grant" ? "выдал роль" : "снял роль";
      const title = key ? `«${key}»` : "";

      if (names.length === 0) {
        // Registry-only lookup came back empty. The count is still known and is
        // still the useful half of the sentence, and it takes the same plural
        // helper - hardcoding "участникам" here would read "1 участникам".
        return done(
          `${verb} ${title} ${count} ${plural(count, "участнику", "участникам", "участникам")}`.trim(),
          [key ? `Роль: ${key}` : ""],
        );
      }

      return done(
        `${verb} ${title} ${count} ${plural(count, "участнику", "участникам", "участникам")}`,
        [names.length <= 6 ? `Кому: ${joinWithAnd(names)}` : `Кому: ${names.slice(0, 6).join(", ")} и ещё ${names.length - 6}`],
      );
    }

    /* --- Map ----------------------------------------------------------- */

    case "point.create":
    case "point.update": {
      // The DAL stores the title in `meta` for exactly this reason - a work point's
      // row is the only place its name exists, and the audit row outlives the point
      // (deleted or not), so the title has to be copied at write time.
      const title = metaText(meta, "title");
      return done(
        action === "point.create" ? "добавил точку на карту" : "изменил точку на карте",
        [title ? `Точка: «${title}»` : ""],
      );
    }

    case "point.deleteAny": {
      // No title here, and none is recoverable: the row is gone, and the audit row
      // did not copy the name before it went. A general label is the honest
      // rendering - inventing a placeholder title would be worse than omitting it.
      return done("удалил точку с карты", []);
    }

    /* --- Events, appeals, polls ----------------------------------------- */

    case "event.create":
    case "event.update": {
      const title = metaText(meta, "title");
      return done(
        action === "event.create" ? "создал мероприятие" : "изменил мероприятие",
        [title ? `Мероприятие: «${title}»` : ""],
      );
    }

    case "event.close":
    case "event.editHours": {
      const attended = metaNumber(meta, "attended");
      const absent = metaNumber(meta, "absent");
      const total = metaNumber(meta, "totalHours");
      const stated = metaNumber(meta, "statedTotal");

      return done(
        action === "event.close" ? "закрыл мероприятие и записал часы" : "исправил часы после закрытия",
        [
          attended !== null || absent !== null
            ? `Присутствовали: ${attended ?? 0}, отсутствовали: ${absent ?? 0}`
            : "",
          total !== null ? `Часов начислено: ${total}` : "",
          // Only worth showing when the manual figure disagreed with the computed
          // one - otherwise it is the same number twice.
          stated !== null && stated !== total ? `Было указано: ${stated}` : "",
        ],
      );
    }

    case "event.deleteAny": {
      return done("удалил мероприятие", [
        metaFlag(meta, "soft") ? "Помечено скрытым" : "",
      ]);
    }

    case "event.rsvp.leave": {
      const reason = metaText(meta, "reason");
      return done("отписался от мероприятия", [reason ? `Причина: ${reason}` : ""]);
    }

    case "appeal.create": {
      const title = metaText(meta, "title");
      return done("создал обращение", [title ? `Обращение: «${title}»` : ""]);
    }

    case "appeal.setStatus": {
      const from = metaText(meta, "from");
      const to = metaText(meta, "to");
      const label = metaText(meta, "label");
      return done("сменил статус обращения", [
        from && to ? `Было: ${from} → стало: ${to}` : "",
        label ?? "",
      ]);
    }

    case "appeal.deleteOwn":
    case "appeal.deleteAny": {
      const author = nameOf(metaText(meta, "author"));
      return done(action === "appeal.deleteOwn" ? "удалил своё обращение" : "удалил обращение", [
        author ? `Автор: ${author}` : "",
      ]);
    }

    case "poll.create": {
      const question = metaText(meta, "question");
      const options = metaNumber(meta, "options");
      return done("создал опрос", [
        question ? `Вопрос: «${question}»` : "",
        options !== null ? `Вариантов: ${options}` : "",
        metaFlag(meta, "multiple") ? "Можно выбрать несколько" : "",
      ]);
    }

    case "poll.vote": {
      const options = metaNumber(meta, "options");
      return done("проголосовал", [options !== null ? `Выбрано вариантов: ${options}` : ""]);
    }

    case "poll.setStatus": {
      const status = metaText(meta, "status");
      return done("изменил статус опроса", [
        status ? `Статус: ${status === "open" ? "Открыт" : "Закрыт"}` : "",
      ]);
    }

    case "poll.deleteOwn":
    case "poll.deleteAny": {
      const author = nameOf(metaText(meta, "author"));
      return done(action === "poll.deleteOwn" ? "удалил свой опрос" : "удалил опрос", [
        author ? `Автор: ${author}` : "",
      ]);
    }

    /* --- Hours --------------------------------------------------------- */

    case "hours.adjust": {
      const hours = metaNumber(meta, "hours");
      const reason = metaText(meta, "reason");
      return withTarget(
        hours === null ? "скорректировал часы" : `${hours >= 0 ? "начислил" : "списал"} ${Math.abs(hours)} ч`,
        reason ? `Причина: ${reason}` : "",
      );
    }

    case "hours.adjust.delete": {
      const subject = nameOf(metaText(meta, "steamId"));
      const hours = metaNumber(meta, "hours");
      return done("отменил корректировку часов", [
        subject ? `Участник: ${subject}` : "",
        hours !== null ? `Часов: ${hours >= 0 ? "+" : ""}${hours}` : "",
      ]);
    }

    default:
      /**
       * Anything without a formatter, including every action written before this
       * reader existed.
       *
       * Note what is *not* here: no `entity#entityId`. That string is the whole
       * problem - a table name and a surrogate key tell a moderator nothing about
       * who was affected, and once it is on screen it is the part they read. The
       * entity filter above the list is where the table name is useful, and it is
       * still there.
       */
      return {
        action: ACTION_LABELS[action] ?? "выполнил действие",
        details: target ? [`Участник: ${target}`] : [],
        expandable: false,
      };
  }
}

/** Russian plural forms, picked by count. Used where a number precedes a noun. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/* -------------------------------------------------------------------------- */

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
  const isStaff = useCan("report.viewAll");

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

  const namesBySteamId = buildNameIndex(rows);

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
          role: joinRoleLabels(entry.roles),
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

      <AuditTrail
        filter={entityFilter}
        onFilterChange={setEntityFilter}
        namesBySteamId={namesBySteamId}
      />
    </>
  );
}

/**
 * Registry display names, keyed by Steam id.
 *
 * The audit reader needs to turn ids into people, and the registry is already
 * loaded on this screen - so the names come from it rather than from a second
 * request. Members who have since left the registry are simply absent from the
 * map, which is what makes the "no name, no line" fallback in `describeAudit` the
 * right behaviour rather than a compromise.
 */
function buildNameIndex(rows: RegistryEntry[]): Map<string, string> {
  const index = new Map<string, string>();

  for (const entry of rows) {
    const name = displayNameOf(entry).trim();
    if (name !== "") index.set(entry.steamId, name);
  }

  return index;
}

function AuditTrail({
  filter,
  onFilterChange,
  namesBySteamId,
}: {
  filter: string;
  onFilterChange: (value: string) => void;
  namesBySteamId: Map<string, string>;
}) {
  const { data, error, pending, refresh } = useAsyncData<AuditEntry[]>(loadAudit);

  /**
   * Resolve an account id to a display name, or null.
   *
   * The registry is the only authority. A miss returns null rather than the id,
   * and the id is not "harmless enough to show": `entity_id` holds a Steam account
   * id for `profile.*` rows, a UUID for `event.*` and `appeal.*`, and whatever
   * primary key the table happens to have otherwise - a plain integer for some of
   * them. A pattern that recognised all of those would be a guess, and a guess that
   * is wrong prints `Участник: 991`. Omitting the line instead leaves a row that
   * still reads correctly.
   */
  const nameOf = (steamId: string | null): string | null => {
    if (!steamId) return null;
    return namesBySteamId.get(steamId) ?? null;
  };

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

  const header = (
    <h3 className="flex items-center gap-2 font-display text-base text-cloud">
      <ScrollText className="h-4 w-4 text-primary" />
      Журнал действий
    </h3>
  );

  if (entries.length === 0) {
    return (
      <Panel>
        {header}
        <EmptyState title="Журнал пуст" hint="Здесь появится каждое изменение: роли, часы, удаления." />
      </Panel>
    );
  }

  return (
    <Panel>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {header}
        <select
          value={filter}
          onChange={(event) => onFilterChange(event.target.value)}
          aria-label="Раздел журнала"
          className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-clock outline-none focus:border-primary"
        >
          <option value="all">Все разделы</option>
          {entities.map((entity) => (
            <option key={entity} value={entity}>
              {ENTITY_LABELS[entity] ?? "Прочее"}
            </option>
          ))}
        </select>
      </div>

      {shown.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          В этом разделе записей пока нет.
        </p>
      ) : (
        <ul className="divide-y divide-border">
          {shown.slice(0, 50).map((entry) => (
            <AuditRow key={entry.id} entry={entry} nameOf={nameOf} />
          ))}
        </ul>
      )}

      {shown.length > 50 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Показаны первые 50 из {shown.length}. Остальные доступны в выгрузке.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * One audit row.
 *
 * Two levels of text, because the information genuinely comes at two levels: the
 * verb belongs with the actor's name, and everything identifying - which member,
 * which role, which point - belongs underneath it. The previous single-line form
 * had to choose between truncating the useful half and overflowing the row.
 *
 * The timestamp is a real `<time>` element on the right, so the rows are a readable
 * list on a wide screen and still legible when the card narrows.
 */
function AuditRow({
  entry,
  nameOf,
}: {
  entry: AuditEntry;
  nameOf: (steamId: string | null) => string | null;
}) {
  const { action, details, expandable } = describeAudit(entry, nameOf);
  const [expanded, setExpanded] = useState(false);

  /**
   * Who acted.
   *
   * Three sources, in order of trust. The registry is the freshest. The server's
   * `actorName` is second, but only once it has been checked - the DAL falls back to
   * the raw account id when a profile is missing, so an un-checked `actorName` is
   * itself a raw identifier. Last is a bare word, which is honest: "Участник" with
   * no name is a gap, a name is not something to be invented.
   */
  const actor =
    nameOf(entry.actor) ??
    (entry.actorName && !looksLikeIdentifier(entry.actorName) ? entry.actorName : null) ??
    (entry.actor ? "Участник" : "Система");

  const stamp = new Date(entry.createdAt);

  return (
    <li className="py-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm leading-snug [overflow-wrap:anywhere]">
            <span className="font-semibold text-cloud">{actor}</span>{" "}
            <span className="text-clock">{action}</span>
          </p>

          {details.length > 0 ? (
            <div
              className={cn(
                "mt-1 space-y-0.5 border-l-2 border-border pl-2.5 text-xs text-muted-foreground",
                // `break-words` handles ordinary long words; `overflow-wrap: anywhere`
                // handles the unbreakable ones - a bare URL in a reason field - which
                // would otherwise set this block's minimum width and push the whole
                // card wider than its container.
                "break-words [overflow-wrap:anywhere] whitespace-normal",
                !expanded && details.length > 1 ? "line-clamp-3" : "",
              )}
            >
              {details.map((line) => (
                <p key={line} className="whitespace-pre-line">
                  {line}
                </p>
              ))}
            </div>
          ) : null}

          {expandable && details.length > 1 ? (
            <button
              type="button"
              onClick={() => setExpanded((open) => !open)}
              className="mt-1 inline-flex items-center gap-1 pl-2.5 text-xs font-medium text-primary transition hover:underline"
            >
              {expanded ? (
                <>
                  Свернуть
                  <ChevronUp className="h-3.5 w-3.5" />
                </>
              ) : (
                <>
                  Показать детали
                  <ChevronDown className="h-3.5 w-3.5" />
                </>
              )}
            </button>
          ) : null}
        </div>

        <time
          dateTime={entry.createdAt}
          className="shrink-0 rounded-md bg-muted-foreground/10 px-1.5 py-0.5 text-[11px] tabular-nums text-muted-foreground"
        >
          {stamp.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}{" "}
          {stamp.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
        </time>
      </div>
    </li>
  );
}
