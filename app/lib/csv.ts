/**
 * CSV serialisation for the applications export.
 *
 * Implemented directly rather than pulling in PapaParse: the requirement is one
 * fixed-shape table, and a ~40-line builder with no dependency is easier to
 * audit than a general-purpose parser for a file that contains applicant PII.
 *
 * Two correctness details that are easy to get wrong and very visible here:
 *
 *   1. Encoding. The data is Russian. Excel on Windows assumes CP1251 for a CSV
 *      with no byte-order mark and renders "Елена Смирнова" as mojibake. Writing
 *      a UTF-8 BOM makes Excel detect the encoding correctly. `semicolon` is
 *      also used as the delimiter, because the default comma is a list separator
 *      in Russian locale and would split every "Иванов, Пётр" into two columns.
 *
 *   2. Formula injection. `motivation` is free text typed by an applicant into a
 *      public form. A cell beginning with =, +, - or @ is interpreted as a
 *      formula by Excel and LibreOffice, so a payload like
 *      `=HYPERLINK("http://evil","click")` would run in the reviewer's
 *      spreadsheet when they open the export. Cells are prefixed with a single
 *      quote, which Excel treats as "this is text", and the quote is invisible
 *      once the cell is opened.
 */

import type { ApplicationSource, ApplicationStatus } from "@/types/party";

/** Column order of the export. Keep in sync with the header row. */
const COLUMNS = [
  { header: "ID", key: "id" },
  { header: "ФИО", key: "name" },
  { header: "Район", key: "district" },
  { header: "Телефон", key: "phone" },
  { header: "Email", key: "email" },
  { header: "Discord", key: "discord" },
  { header: "SteamID64", key: "steam" },
  { header: "Источник", key: "source" },
  { header: "Мотивация", key: "motivation" },
  { header: "Статус", key: "status" },
  { header: "Заметки", key: "notes" },
  { header: "Подана", key: "submittedAt" },
  { header: "Проверена", key: "reviewedAt" },
] as const satisfies readonly { header: string; key: keyof ApplicationCsvRow }[];

/** The subset of an application row the export needs. */
export interface ApplicationCsvRow {
  id: string;
  name: string;
  district: string;
  phone: string;
  email: string;
  discord: string;
  steam: string | null;
  source: ApplicationSource;
  motivation: string;
  status: ApplicationStatus;
  notes: string;
  submittedAt: string;
  reviewedAt: string | null;
}

/** Human-readable replacements for the machine-readable enum values. */
const SOURCE_LABEL: Record<ApplicationSource, string> = {
  native: "Сайт",
  google: "Google Форма",
};

const STATUS_LABEL: Record<ApplicationStatus, string> = {
  pending: "На рассмотрении",
  approved: "Одобрена",
  rejected: "Отклонена",
};

/** Prefix that forces spreadsheet software to treat a cell as literal text. */
const FORMULA_GUARD = "'";

/**
 * Semicolon rather than comma: in a Russian locale the comma is the decimal
 * separator and the list separator, so a comma-delimited file with Cyrillic
 * content re-imports into the wrong number of columns.
 */
const FIELD_SEPARATOR = ";";

/** UTF-8 byte-order mark, so Excel does not decode the file as CP1251. */
const BOM = "﻿";

/** RFC 4180 mandates CRLF. */
const CRLF = "\r\n";

/**
 * Escape one field per RFC 4180 and defuse spreadsheet formula injection.
 *
 * Order matters: the guard is added first, then quoting is applied to the
 * result. Quoting alone does not stop a formula — Excel strips the quotes and
 * evaluates the contents regardless.
 */
function escapeCell(value: string | null | undefined): string {
  // Nullable columns are written as an empty field so every row in a column has
  // the same width, which a ragged CSV would break on re-import.
  const cell = value ?? "";

  // A leading =, +, - or @ is the formula trigger in both Excel and
  // LibreOffice. Tab and CR are included because leading whitespace followed by
  // an operator is also treated as a formula.
  const guarded = /^[=+\-@\t\r]/.test(cell) ? FORMULA_GUARD + cell : cell;

  if (!/[";\n\r]/.test(guarded)) return guarded;

  // RFC 4180: a literal quote inside a quoted field is doubled.
  return `"${guarded.replace(/"/g, '""')}"`;
}

/**
 * Build the full CSV document, including the UTF-8 BOM.
 *
 * Line endings are CRLF as specified by RFC 4180; Excel on Windows also expects
 * them and mis-parses a bare LF inside a quoted field containing a newline.
 */
export function buildApplicationsCsv(rows: ApplicationCsvRow[]): string {
  const header = COLUMNS.map((column) => escapeCell(column.header)).join(FIELD_SEPARATOR);

  // Both label maps are total over their enum, so an unexpected value is
  // impossible by type rather than by a runtime fallback.
  const body = rows.map((row) =>
    COLUMNS.map((column) => {
      switch (column.key) {
        case "source":
          return escapeCell(SOURCE_LABEL[row.source]);
        case "status":
          return escapeCell(STATUS_LABEL[row.status]);
        default:
          return escapeCell(row[column.key]);
      }
    }).join(FIELD_SEPARATOR),
  );

  return BOM + [header, ...body].join(CRLF) + CRLF;
}

/**
 * Hand the CSV to the browser as a download.
 *
 * The object URL is revoked on the next tick: revoking synchronously races the
 * download in some browsers and cancels it.
 */
export function downloadCsv(csv: string, filename: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  // Revoked on the next tick rather than synchronously: revoking immediately
  // races the download in some browsers and cancels it.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** `party_applications_2026-09-27.csv` — the filename required by the brief. */
export function applicationsCsvFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10);
  return `party_applications_${stamp}.csv`;
}

/* -------------------------------------------------------------------------- */
/* Registry export                                                              */
/* -------------------------------------------------------------------------- */

const REGISTRY_COLUMNS = [
  { header: "Имя", key: "name" },
  { header: "Steam persona", key: "persona" },
  { header: "SteamID64", key: "steamId" },
  { header: "Роль", key: "role" },
  { header: "Статус", key: "status" },
  { header: "Часов", key: "totalHours" },
  { header: "Мероприятий", key: "eventsAttended" },
  { header: "Пропущено", key: "eventsAbsent" },
  { header: "Телеграм", key: "telegram" },
  { header: "Discord", key: "discord" },
  { header: "Телефон", key: "phone" },
  { header: "О себе", key: "about" },
  { header: "В партии с", key: "createdAt" },
] as const satisfies readonly { header: string; key: keyof RegistryCsvRow }[];

export interface RegistryCsvRow {
  name: string;
  persona: string;
  steamId: string;
  role: string;
  status: string;
  totalHours: number;
  eventsAttended: number;
  eventsAbsent: number;
  telegram: string | null;
  discord: string | null;
  phone: string | null;
  about: string;
  createdAt: string;
}

const REGISTRY_ROLE_LABEL: Record<string, string> = {
  leader: "Лидер",
  admin: "Админ",
  member: "Работник",
};

const REGISTRY_STATUS_LABEL: Record<string, string> = {
  approved: "Одобрен",
  pending: "На рассмотрении",
  rejected: "Отклонён",
};

/**
 * Build the registry export.
 *
 * Same encoding, delimiter and formula guard as the applications export, for the
 * same reasons: Russian text in Excel, and free-text columns (`about`, a member's
 * own "about me" text) that can start with a formula operator.
 *
 * `display_name` is resolved to the same string the UI shows, so a member who set
 * a character name is exported under that name rather than their Steam handle.
 */
export function buildRegistryCsv(rows: RegistryCsvRow[]): string {
  const header = REGISTRY_COLUMNS.map((column) => escapeCell(column.header)).join(FIELD_SEPARATOR);

  const body = rows.map((row) =>
    REGISTRY_COLUMNS.map((column) => {
      switch (column.key) {
        case "role":
          return escapeCell(REGISTRY_ROLE_LABEL[row.role] ?? row.role);
        case "status":
          return escapeCell(REGISTRY_STATUS_LABEL[row.status] ?? row.status);
        default:
          return escapeCell(String(row[column.key]));
      }
    }).join(FIELD_SEPARATOR),
  );

  return BOM + [header, ...body].join(CRLF) + CRLF;
}

/** `svoboda_registry_2026-09-27.csv` */
export function registryCsvFilename(now: Date = new Date()): string {
  return `svoboda_registry_${now.toISOString().slice(0, 10)}.csv`;
}
