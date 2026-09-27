/**
 * Human-readable errors for schema drift.
 *
 * A missing column is the single most common way this project breaks: the code is
 * written against `supabase/migrations/*.sql`, and that file is applied to the live
 * database by hand, so a new column silently does not exist until someone runs it.
 * PostgREST then answers with a raw message — "column party_events.created_by does
 * not exist" — which arrives in the UI buried under an English `Failed to read
 * events:` prefix and a stack trace, in a panel that used to work.
 *
 * That is correct behaviour: a schema mismatch is a real bug and must stay loud. A
 * half-migrated database silently pretending to work is far worse. What is worth
 * fixing is only the legibility, so the message says which column is missing and
 * which file to run.
 *
 * The mapping is keyed on the Postgres SQLSTATE, so it cannot fire on ordinary
 * failures: a network error or a permissions error keeps today's exact behaviour.
 */

/** The migration that creates the portal tables, and the answer to "what do I run?". */
const PORTAL_MIGRATION = "supabase/migrations/002_portal.sql";

/** Minimal shape shared by a PostgREST error and anything else we might be handed. */
type QueryError = { code?: string | null; message: string };

/** Postgres SQLSTATEs for "the thing I asked for is not in the schema". */
const UNDEFINED_COLUMN = "42703";
const UNDEFINED_TABLE = "42P01";

/**
 * PostgREST's own code for a missing table.
 *
 * It matters that this list is not just the two SQLSTATEs. A missing *column* comes
 * back as `42703` because PostgREST forwards the Postgres error, but a missing
 * *table* is caught by PostgREST's schema cache before Postgres ever sees it, so it
 * arrives as `PGRST205` instead. Verified against a live database with
 * `event_declines` absent: `42703` for `party_events.deleted_at`,
 * `PGRST205` for the table.
 *
 * Reading only the SQLSTATE would have meant a table added by a migration that has
 * not been applied yet takes the whole schedule down, while a column going missing
 * degrades gracefully — an inconsistency that is purely an accident of which layer
 * rejected the query.
 */
const SCHEMA_DRIFT_CODES: ReadonlySet<string> = new Set([
  UNDEFINED_COLUMN,
  UNDEFINED_TABLE,
  "PGRST205",
  "PGRST204",
]);

/**
 * Fallback for proxies and pools that drop the SQLSTATE but keep the wording.
 * Only the two phrases Postgres actually uses for a schema mismatch are matched,
 * so this cannot swallow an unrelated "does not exist" from application logic.
 */
const SCHEMA_HINT =
  /(?:column|table|relation)\s+"?([\w.]+)"?\s+does not exist|Could not find the table '([\w.]+)'/i;

function schemaNameFrom(error: QueryError): string | null {
  const match = SCHEMA_HINT.exec(error.message);
  if (!match) return null;
  return match[1] ?? match[2] ?? null;
}

function isSchemaDrift(error: QueryError): boolean {
  if (error.code && SCHEMA_DRIFT_CODES.has(error.code)) return true;
  // A code we recognise as *not* schema drift is authoritative: trust it over the
  // wording, so an application error that happens to say "does not exist" is left
  // alone. Only when the code is missing do we fall back to parsing the message.
  if (error.code) return false;
  return schemaNameFrom(error) !== null;
}

/**
 * Whether the failure means "a table or column this query named is not in the
 * database".
 *
 * Callers that can degrade gracefully rather than throw — the schedule falls back
 * to an empty decline list when `event_declines` has not been created yet — need
 * the same judgement `queryError` makes, so it is exported rather than duplicated.
 * Getting this subtly wrong is not cosmetic: miss the code and a pending migration
 * turns into a broken tab.
 */
export function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("message" in error)) return false;
  return isSchemaDrift(error as QueryError);
}

/**
 * Wrap a failed query as an `Error` the UI can show.
 *
 * `context` is the operation, e.g. `"Failed to read events"`. It is kept as the
 * prefix in every case except schema drift, so messages stay exactly as specific as
 * they are today for every failure that is not a missing column.
 */
export function queryError(context: string, error: unknown): Error {
  const candidate =
    typeof error === "object" && error !== null && "message" in error
      ? (error as { message?: unknown; code?: unknown })
      : null;

  const detail = typeof candidate?.message === "string" ? candidate.message : null;
  const base = detail ?? "unknown error";

  if (candidate && detail && isSchemaDrift(candidate as QueryError)) {
    const name = schemaNameFrom(candidate as QueryError) ?? "нужной объект";
    return new Error(
      `База данных устарела: нет ${name}. Примените ${PORTAL_MIGRATION} в Supabase SQL Editor. ` +
        `Ошибка Postgres: ${base}`,
    );
  }

  return new Error(`${context}: ${base}`);
}
