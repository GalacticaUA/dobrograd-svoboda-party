"use client";

import { useState, useTransition } from "react";
import { AtSign, Eye, EyeOff, Loader2, Save, User } from "lucide-react";
import { toast } from "sonner";

import { LoadingBlock, PageTitle, Panel, fieldCls } from "@/components/portal/primitives";
import { loadAccount, saveAccount } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { displayNameOf, type AccountProfile } from "@/lib/portal/types";

/**
 * The member's own settings.
 *
 * This tab exists because "why can a regular member not edit their account" was a
 * fair complaint: account settings need no role at all. Everyone who is signed in
 * may set their own character name, description and availability.
 *
 * The Steam persona is shown read-only on purpose. It is the identity Steam
 * vouched for, so letting someone type over it would destroy the link between a
 * profile row and a real account. `display_name` sits alongside it as the
 * character name, and is what the portal shows everywhere else.
 *
 * Loading and editing are split into two components. The form seeds its fields
 * from the loaded row in `useState` initialisers, which only run on mount; doing
 * that from an effect instead would re-seed the inputs on every render caused by
 * the user's own typing. Remounting is done with a `key` on the profile id
 * rather than on the profile object, so a successful save updates the data
 * without throwing away the field the user is still focused on.
 */
export function AccountTab() {
  const { data, error, pending, refresh, setData } = useAsyncData<AccountProfile>(loadAccount);

  if (pending) return <LoadingBlock />;
  if (error || !data) {
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">{error ?? "Профиль не найден."}</p>
        <button type="button" onClick={() => refresh()} className="mt-3 text-sm text-primary hover:underline">
          Повторить
        </button>
      </Panel>
    );
  }

  return <AccountForm key={data.steamId} profile={data} onSaved={setData} />;
}

function AccountForm({
  profile,
  onSaved,
}: {
  profile: AccountProfile;
  onSaved: (profile: AccountProfile) => void;
}) {
  const [saving, startTransition] = useTransition();

  const [displayName, setDisplayName] = useState(profile.displayName);
  const [about, setAbout] = useState(profile.about);
  const [telegram, setTelegram] = useState(profile.telegram ?? "");
  const [contactsPublic, setContactsPublic] = useState(profile.contactsPublic);

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveAccount({ displayName, about, telegram, contactsPublic });
      if (result.ok) {
        onSaved(result.data);
        toast.success("Настройки сохранены");
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PageTitle
        title="Аккаунт"
        sub="Имя персонажа и контакты. Видны участникам партии, не публичному сайту."
      />

      <Panel className="flex items-center gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full border border-border bg-background">
          <User className="h-5 w-5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="truncate font-display text-base text-cloud">
            {displayNameOf(profile) || "Без имени"}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            Steam: {profile.persona || "—"} · {profile.steamId}
          </p>
        </div>
      </Panel>

      <Panel className="space-y-4">
        <div>
          <label htmlFor="displayName" className="mb-1.5 block text-sm text-cloud">
            Имя персонажа
          </label>
          <input
            id="displayName"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={60}
            placeholder={profile.persona || "Как вас звать в партии"}
            className={fieldCls}
          />
          <p className="mt-1.5 text-xs text-muted-foreground">
            Пусто - значит будет показано имя из Steam ({profile.persona || "нет"}).
          </p>
        </div>

        <div>
          <label htmlFor="about" className="mb-1.5 block text-sm text-cloud">
            О себе
          </label>
          <textarea
            id="about"
            value={about}
            onChange={(event) => setAbout(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Чем занимаетесь в партии, что умеете"
            className={fieldCls}
          />
        </div>

        <div>
          <label htmlFor="telegram" className="mb-1.5 block text-sm text-cloud">
            Дискорд
          </label>
          <div className="relative">
            <AtSign className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <input
              id="telegram"
              value={telegram}
              onChange={(event) => setTelegram(event.target.value)}
              placeholder="username"
              className={`${fieldCls} pl-9`}
            />
          </div>
        </div>

        <button
          type="button"
          onClick={() => setContactsPublic((value) => !value)}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-left transition hover:border-primary"
        >
          <span className="min-w-0">
            <span className="block text-sm text-cloud">Показывать контакты другим</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">
              {contactsPublic
                ? "Ваш дискорд видят участники партии"
                : "Контакты видите только вы и сотрудники"}
            </span>
          </span>
          {contactsPublic ? (
            <Eye className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <EyeOff className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>
      </Panel>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Сохранить
        </button>
      </div>
    </form>
  );
}
