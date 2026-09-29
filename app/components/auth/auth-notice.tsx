"use client";

import { useEffect } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";

/**
 * Turns a `?auth=failed&reason=...` redirect into a readable message.
 *
 * The auth routes redirect rather than render an error page, because the user is
 * mid-navigation and has no reason to be looking at a status code. That leaves
 * nothing on screen, so without this component a failed sign-in looks like the
 * site simply ignored the button.
 *
 * `reason=missing` is the important one during setup: it means the deployment
 * itself is incomplete, and the `missing` list names exactly which variables to
 * fill in. The names are passed from a Server Component because the env module
 * is `server-only` - nothing is read from the browser, and no value is exposed.
 */

const REASON_COPY: Record<string, string> = {
  config: "Вход через Steam не настроен на сервере.",
  // Steam does complete the round trip against a localhost realm, so a local
  // deployment is a supported configuration and must not be steered towards a
  // tunnel or told to change an env var that is already correct.
  assertion: "Steam не подтвердил вход. Попробуйте ещё раз.",
  identity: "Не удалось получить профиль Steam.",
  rate: "Слишком много попыток входа. Подождите минуту.",
  internal: "Внутренняя ошибка входа. Попробуйте позже.",
  required: "Войдите через Steam, чтобы открыть панель администратора.",
  forbidden: "У вашей учётной записи нет доступа к панели администратора.",
  pending: "Профиль ещё не одобрен координационным советом.",
  expired: "Сессия истекла: 24 часа с момента входа. Войдите снова.",
};

export function AuthNotice({ missing }: { missing: string[] }) {
  const params = useSearchParams();
  const reason = params.get("reason");
  const auth = params.get("auth");

  const key = `${auth}:${reason}`;

  useEffect(() => {
    if (auth !== "failed" && auth !== "required" && auth !== "forbidden") return;

    // A successful sign-in lands on "/" with no params, so this only fires for
    // the failure and guard paths.
    const title = reason ? (REASON_COPY[reason] ?? REASON_COPY.internal) : REASON_COPY.required;

    if (reason === "config" && missing.length > 0) {
      toast.error(`${title} Заполните в .env.local: ${missing.join(", ")}`, {
        duration: Infinity,
        id: "auth-config",
      });
      return;
    }

    const method = auth === "failed" ? "error" : "info";
    toast[method](title, { id: `auth-${key}` });

    // Drop the params so a refresh does not re-fire the same toast.
    const url = new URL(window.location.href);
    url.searchParams.delete("auth");
    url.searchParams.delete("reason");
    window.history.replaceState(null, "", url);
  }, [auth, reason, key, missing]);

  return null;
}
