"use client";

import { useEffect, useState, useTransition } from "react";
import { CheckCircle2, Loader2, Send, AlertCircle } from "lucide-react";
import { toast } from "sonner";

import { Panel, fieldCls } from "@/components/portal/primitives";
import { submitApplication } from "@/lib/auth/actions";

/**
 * Districts offered by the form. Mirrors the check constraint on
 * `join_applications.district` and the `DISTRICTS` list in the DAL - three places
 * that have to agree, and the database is the one that ultimately decides.
 */
// const DISTRICTS = ["Центральный", "Заречный", "Северный", "Восточный", "Другой"] as const;

interface FormState {
  name: string;
  // email: string;
  // phone: string;
  discord: string;
  steam: string;
  // district: string;
  motivation: string;
}

const EMPTY: FormState = {
  name: "",
  // email: "",
  // phone: "",
  discord: "",
  steam: "",
  // district: "Другой",
  motivation: "",
};

const COOLDOWN_KEY = "party_application_cooldown_until";
const COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * The membership application form on /join.
 *
 * Client-side `required` and `maxLength` exist so a person finds out before
 * submitting, not because they enforce anything - the DAL re-validates every
 * field against the same bounds as the column checks, since this endpoint is
 * reachable by anyone who can replay a Server Action id from curl.
 *
 * The SteamID field is prefilled when the visitor is signed in, because a member
 * removed from the party is the one person for whom a typo would be costly: the
 * reviewer approves the SteamID on the application, and a mistyped one creates a
 * brand-new empty profile instead of restoring the one holding their hours.
 * An empty field is fine too - the form explicitly allows it, and staff can still
 * approve the paper application.
 */
export function ApplicationForm({ defaultSteamId = "" }: { defaultSteamId?: string }) {
  const [values, setValues] = useState<FormState>({ ...EMPTY, steam: defaultSteamId });
  const [submitted, setSubmitted] = useState(false);
  const [remainingHours, setRemainingHours] = useState<number | null>(null);
  const [sending, startTransition] = useTransition();

  useEffect(() => {
    const checkCooldown = () => {
      const cooldownUntil = localStorage.getItem(COOLDOWN_KEY);
      if (cooldownUntil) {
        const diffMs = parseInt(cooldownUntil, 10) - Date.now();
        if (diffMs > 0) {
          setRemainingHours(Math.ceil(diffMs / (1000 * 60 * 60)));
          return;
        }
        localStorage.removeItem(COOLDOWN_KEY);
      }
      setRemainingHours(null);
    };

    checkCooldown();
  }, []);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const submit = (event: React.FormEvent) => {
    event.preventDefault();

    if (remainingHours !== null) {
      toast.error(`Повторная отправка будет доступна через ${remainingHours} ч.`);
      return;
    }

    startTransition(async () => {
      const result = await submitApplication(values);

      if (result.ok) {
        const unlockTime = Date.now() + COOLDOWN_MS;
        localStorage.setItem(COOLDOWN_KEY, unlockTime.toString());
        setRemainingHours(24);

        setSubmitted(true);
        setValues({ ...EMPTY, steam: defaultSteamId });
        toast.success("Заявка отправлена");
      } else {
        toast.error(result.error);
      }
    });
  };
  if (remainingHours !== null && !submitted) {
    return (
      <Panel className="text-center">
        <AlertCircle className="mx-auto h-10 w-10 text-amber-500" aria-hidden />
        <p className="mt-3 font-display text-lg text-cloud">Заявка уже подана</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Вы уже отправляли заявку. Повторная отправка будет доступна через{" "}
          <span className="font-semibold text-cloud">{remainingHours} ч.</span>
        </p>
      </Panel>
    );
  }
  if (submitted) {
    return (
      <Panel className="text-center">
        <CheckCircle2 className="mx-auto h-10 w-10 text-primary" aria-hidden />
        <p className="mt-3 font-display text-lg text-cloud">Заявка принята</p>
        <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
          Мы свяжемся с вами и определим формат работы. Заявка попадает в очередь
          координационного совета - решение принимает человек, а не эта страница.
        </p>
        <button
          type="button"
          onClick={() => setSubmitted(false)}
          className="mt-4 text-sm text-primary hover:underline"
        >
          Отправить ещё одну
        </button>
      </Panel>
    );
  }

  return (
    <Panel>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="block text-sm text-clock">
            Имя и фамилия
            <input
              value={values.name}
              onChange={(event) => set("name", event.target.value)}
              maxLength={80}
              required
              autoComplete="name"
              className={`${fieldCls} mt-1`}
            />
          </label>

          {/* <label className="block text-sm text-clock">
            Район
            <select
              value={values.district}
              onChange={(event) => set("district", event.target.value)}
              className={`${fieldCls} mt-1`}
            >
              {DISTRICTS.map((district) => (
                <option key={district} value={district}>
                  {district}
                </option>
              ))}
            </select>
          </label> */}

          <label className="block text-sm text-clock">
            SteamID64
            <input
              value={values.steam}
              onChange={(event) => set("steam", event.target.value)}
              placeholder="76561198000000000"
              inputMode="numeric"
              maxLength={30}
              className={`${fieldCls} mt-1`}
            />
          </label>

          {/* <label className="block text-sm text-clock">
            Телефон
            <input
              value={values.phone}
              onChange={(event) => set("phone", event.target.value)}
              maxLength={32}
              autoComplete="tel"
              className={`${fieldCls} mt-1`}
            />
          </label> */}
{/* 
          <label className="block text-sm text-clock">
            Почта
            <input
              value={values.email}
              onChange={(event) => set("email", event.target.value)}
              type="email"
              maxLength={254}
              autoComplete="email"
              className={`${fieldCls} mt-1`}
            />
          </label> */}

          <label className="block text-sm text-clock">
            Discord
            <input
              value={values.discord}
              onChange={(event) => set("discord", event.target.value)}
              maxLength={120}
              className={`${fieldCls} mt-1`}
            />
          </label>
        </div>

        <label className="block text-sm text-clock">
          Почему хотите в партию
          <textarea
            value={values.motivation}
            onChange={(event) => set("motivation", event.target.value)}
            rows={4}
            maxLength={300}
            className={`${fieldCls} mt-1`}
          />
        </label>

        <p className="text-xs text-muted-foreground">
          SteamID64 необязателен, но с ним мы сможем привязать заявку к вашему
          профилю и вернуть накопленные часы, если вы раньше состояли в партии.
        </p>

        <button
          type="submit"
          disabled={sending}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-5 py-2.5 text-sm font-medium text-primary-foreground transition hover:bg-primary/85 disabled:opacity-60"
        >
          {sending ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
          ) : (
            <Send className="h-4 w-4" aria-hidden />
          )}
          {sending ? "Отправляем…" : "Отправить заявку"}
        </button>
      </form>
    </Panel>
  );
}
