"use server";

/**
 * Server Actions.
 *
 * Every action in this file re-derives the caller's identity from the signed
 * session cookie before touching data, and none of them trust a value passed in
 * by the browser.
 *
 * This is not defensive repetition. A Server Action is an HTTP POST endpoint
 * reachable by anyone: Next.js compiles an encrypted action id into the client
 * bundle, and that id can be replayed from curl. A guard in the page component
 * or in a React context protects nothing, because it is not on the request
 * path. The check has to be here, and it has to be here every time.
 *
 * Cookie deletion is only legal inside a Server Action or Route Handler, never
 * during render. That is why a failed check is reported to the caller and the
 * stale cookie is cleared here, rather than inside the DAL.
 */

import { revalidatePath } from "next/cache";

import {
  createApplication,
  FormError,
  getSessionProfile,
  listApplications,
  setApplicationStatus,
  SessionError,
} from "@/lib/auth/dal";
import { destroySession } from "@/lib/auth/session";
import { buildApplicationsCsv } from "@/lib/csv";
import type { ApplicationRecord, ProfileDTO } from "@/types/auth";

/**
 * Discriminated result returned to client components.
 *
 * Server Action return values are serialised and sent to the browser, so this
 * carries only what the UI needs — never a database row and never a secret.
 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; reason?: string };

/** Russian copy for each session failure, shown verbatim in the dialog. */
const SESSION_ERROR_MESSAGE: Record<string, string> = {
  missing: "Сессия не найдена. Войдите через Steam.",
  invalid: "Сессия недействительна. Войдите через Steam заново.",
  expired: "Сессия истекла: 24 часа с момента входа. Требуется повторная авторизация.",
  unapproved: "Профиль ещё не одобрен советом.",
  forbidden: "Недостаточно прав для этого действия.",
  database: "База данных не настроена. Проверьте переменные окружения.",
};

/**
 * Map a thrown SessionError into a user-facing result and clear the cookie.
 *
 * The `missing` case deliberately does not destroy a cookie, since there is
 * nothing to clear; every other case means the cookie is present but unusable
 * and must be wiped so the UI stops treating it as a live session.
 */
async function toFailure(error: unknown): Promise<ActionResult<never>> {
  if (error instanceof SessionError) {
    if (error.reason !== "missing") {
      await destroySession();
    }
    return {
      ok: false,
      error: SESSION_ERROR_MESSAGE[error.reason] ?? "Не удалось подтвердить сессию.",
      reason: error.reason,
    };
  }

  // Anything else is a bug or a database outage. The message is intentionally
  // generic: a raw Supabase error can reveal table and column names.
  console.error("[auth] unexpected failure:", error);
  return { ok: false, error: "Внутренняя ошибка. Попробуйте позже." };
}

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Read the current session for client components that need to react to a
 * change (the dialog, the header button). This is a read, not a guard: it never
 * authorises anything, so it returns the DTO rather than throwing.
 */
export async function getCurrentProfile(): Promise<ProfileDTO | null> {
  const result = await getSessionProfile();
  return result.ok ? result.profile : null;
}

/**
 * Sign out.
 *
 * Destroys the cookie server-side. The brief asks for the 24-hour token to be
 * explicitly purged, which matters most if the browser profile is shared: the
 * token must not survive on disk.
 */
export async function signOut(): Promise<ActionResult> {
  await destroySession();
  revalidatePath("/", "layout");
  return { ok: true, data: undefined };
}

/* -------------------------------------------------------------------------- */
/* Application review                                                          */
/* -------------------------------------------------------------------------- */

export type ReviewResult = ActionResult<{ application: ApplicationRecord }>;

/**
 * Approve or reject an application.
 *
 * `id` arrives from the browser and is therefore untrusted; it is used only as a
 * database key, and the DAL re-checks staff authority before writing. The
 * returned row lets the client update its table immediately, so the list
 * re-renders without polling.
 */
export async function reviewApplication(
  id: string,
  status: "approved" | "rejected",
  notes?: string,
): Promise<ReviewResult> {
  try {
    if (!id) {
      return { ok: false, error: "Не указан идентификатор заявки." };
    }
    if (status !== "approved" && status !== "rejected") {
      return { ok: false, error: "Недопустимый статус." };
    }

    const application = await setApplicationStatus({ id, status, notes });
    revalidatePath("/admin");

    return { ok: true, data: { application } };
  } catch (error) {
    return toFailure(error);
  }
}

/* -------------------------------------------------------------------------- */
/* Public application form                                                      */
/* -------------------------------------------------------------------------- */

export type SubmitApplicationResult = ActionResult<{ id: number }>;

/**
 * File a membership application from the public form.
 *
 * The only action in this project that is *meant* to be callable without a
 * session, which means the usual "re-derive the caller" step has nothing to
 * derive. That is the whole security story of this endpoint and it is worth
 * stating plainly: anyone on the internet can insert a row into
 * `join_applications`, and the protections are validation, RLS denying all
 * reads, and staff reviewing the queue by hand. Nobody is granted access by
 * submitting — membership is only ever granted by `setApplicationStatus`, behind
 * a staff check.
 *
 * The field lengths sent from the browser are ignored; the DAL re-validates
 * against the same bounds as the column checks. A `maxLength` attribute is a
 * convenience for the person typing, not a boundary.
 */
export async function submitApplication(input: {
  name: string;
  // email: string;
  // phone: string;
  discord: string;
  steam: string;
  // district: string;
  motivation: string;
}): Promise<SubmitApplicationResult> {
  try {
    const id = await createApplication({
      name: String(input.name ?? ""),
      // email: String(input.email ?? ""),
      // phone: String(input.phone ?? ""),
      discord: String(input.discord ?? ""),
      steam: String(input.steam ?? ""),
      // district: String(input.district ?? "Другой"),
      motivation: String(input.motivation ?? ""),
    });

    return { ok: true, data: { id } };
  } catch (error) {
    // `FormError` is the DAL's explicit permission to show a message to an
    // anonymous caller, and only the validation branches throw it. Everything
    // else — a constraint violation, a dead connection, a bug — falls through to
    // the generic line so no table or column name can reach the public form.
    if (error instanceof FormError) {
      return { ok: false, error: error.message };
    }

    console.error("[auth] application submission failed:", error);
    return { ok: false, error: "Не удалось отправить заявку. Попробуйте позже." };
  }
}

/* -------------------------------------------------------------------------- */
/* CSV export                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Build the CSV export server-side and hand the finished text to the browser.
 *
 * The data is fetched and formatted here, after authorisation, so applicant PII
 * is never serialised into a public page payload. The client receives only the
 * final string and turns it into a download — it cannot use the response to
 * re-query anything, and it never holds a privileged Supabase credential.
 */
export async function exportApplicationsCsv(): Promise<ActionResult<{ csv: string }>> {
  try {
    const applications = await listApplications();
    const csv = buildApplicationsCsv(applications);

    return { ok: true, data: { csv } };
  } catch (error) {
    return toFailure(error);
  }
}
