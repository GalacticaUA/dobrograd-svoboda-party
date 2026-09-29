"use client";

import { useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { LayoutDashboard, LogOut, ShieldCheck, User, X } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { PortalDialog } from "@/components/portal/portal-dialog";
import { signOut } from "@/lib/auth/actions";
import { steamProfileUrl } from "@/lib/auth/profile";
import { cn } from "@/lib/utils";
import type { Action } from "@/lib/permissions";
import type { ProfileDTO } from "@/types/auth";
import steamLogo from "@/assets/steam.png";


/**
 * Steam authentication button and modal.
 *
 * Renders one of three states:
 *   - signed out:      a Steam-branded sign-in button
 *   - pending:         identity shown, portal sections visibly locked
 *   - rejected:        identity, an explanation, and a link back to the /join form
 *   - approved staff: identity, an admin-panel link, and a sign-out button
 *
 * `pending` and `rejected` are separate states on purpose even though both end in
 * a closed portal. `pending` is somebody who has never been vetted, and there is
 * nothing they can do but wait. `rejected` may be an application the council
 * turned down *or* a member who was later expelled by `removeMember`, and the
 * second case has a way out - a new application. Telling both groups "ждите
 * одобрения" strands the expelled member indefinitely, so the copy points at the
 * form. The two are not distinguishable from the profile row alone, and guessing
 * wrong in the other direction would offer re-application to somebody who is not
 * entitled to it, which is why the wording covers both cases instead.
 *
 * The `profile` prop is display data only. It was produced by the server and is
 * never treated as authority here - every privileged action re-verifies the
 * session independently, so tampering with this component in the browser grants
 * nothing.
 *
 * The portal is a separate dialog with its own state rather than a tab inside
 * this one. A dialog stacked on a dialog produces two focus traps fighting over
 * the keyboard and two scrims, and the portal is a full-height surface that has
 * no business being nested inside a 28rem card. Opening it closes this dialog.
 */

const STATUS_COPY: Record<ProfileDTO["status"], { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  approved: { label: "Одобрен", variant: "default" },
  pending: { label: "На рассмотрении", variant: "secondary" },
  rejected: { label: "Отклонён", variant: "destructive" },
};

/**
 * The dialog says "Председатель" and "Администратор" where every other surface
 * says "Лидер" and "Админ". Kept, deliberately and only here: this is the one
 * place a member is talking to the site rather than administering it, and the
 * formal word is the one that reads as an answer to "what am I".
 *
 * A set, because a person can hold several. This used to be a single badge off
 * `profile.role`, which is the highest-standing role only — somebody who is an
 * admin *and* a moderator was told they were an administrator and nothing else.
 */
const ROLE_COPY: Record<ProfileDTO["role"], string> = {
  leader: "Председатель",
  admin: "Администратор",
  moderator: "Модератор",
  member: "Участник",
};

/** Amber for pending, green for approved, red for rejected. */
const DOT_COLOR: Record<ProfileDTO["status"], string> = {
  approved: "bg-emerald-400",
  pending: "bg-amber-400",
  rejected: "bg-destructive",
};

export function AuthDialog({
  profile,
  permissions,
}: {
  profile: ProfileDTO | null;
  permissions: readonly Action[];
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [portalOpen, setPortalOpen] = useState(false);

  const isApproved = profile !== null && profile.status === "approved";
  // The admin panel is reached by `application.review`, not by holding a staff
  // role. That is the difference the whole role system exists for: somebody who
  // triages sign-in requests has no business expelling members or correcting
  // hours, and `isStaffRole` gave them all of it.
  const canUseAdmin = isApproved && permissions.includes("application.review");

  function handleSignOut() {
    startTransition(async () => {
      await signOut();
      setOpen(false);
      // Drop any server-rendered session state, then bring the header button
      // back to its signed-out appearance.
      router.refresh();
    });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            aria-label={profile ? `Аккаунт: ${profile.persona || profile.steamId}` : "Войти через Steam"}
            className={cn(
              "relative rounded-full p-2.5 transition-all",
              "border border-border bg-card/60 hover:border-primary/50 hover:bg-card",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "shadow-glow-sm hover:shadow-glow",
            )}
          >
            {profile?.avatarUrl ? (
              <Avatar className="h-6 w-6">
                <AvatarImage src={profile.avatarUrl} alt="" />
                <AvatarFallback className="h-6 w-6 text-[10px]">С</AvatarFallback>
              </Avatar>
            ) : (
              <User className="h-5 w-5 text-cloud" aria-hidden />
            )}

            {profile ? (
              <span
                aria-hidden
                className={cn(
                  "absolute -bottom-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-background",
                  DOT_COLOR[profile.status],
                )}
              />
            ) : null}
          </button>
        </DialogTrigger>

        <DialogContent className="border-border bg-card sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="font-display text-xl text-cloud">
              Авторизация в системе
            </DialogTitle>
            <DialogDescription>
              Вход для членов совета и сотрудников партии
            </DialogDescription>
          </DialogHeader>

          {profile ? (
            <SignedIn
              profile={profile}
              canUseAdmin={canUseAdmin}
              isPending={isPending}
              onSignOut={handleSignOut}
              onOpenPortal={() => {
                setOpen(false);
                setPortalOpen(true);
              }}
            />
          ) : (
            <SignedOut />
          )}
        </DialogContent>
      </Dialog>

      {profile && isApproved ? (
        <PortalDialog
          open={portalOpen}
          onOpenChange={setPortalOpen}
          profile={profile}
          permissions={permissions}
        />
      ) : null}
    </>
  );
}

function SignedOut() {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Вход подтверждает принадлежность к партии через аккаунт Steam. Мы получаем
        только публичные данные профиля: ник, аватар и SteamID64.
      </p>

        {/* A plain link, not a form post: the flow is a browser navigation through
            Steam, so a GET route is the correct mechanism. */}
        <a
          href="/api/auth/steam"
          className="flex w-full items-center justify-center gap-2.5 rounded-full bg-[#1b2838] px-6 py-3 font-medium text-white transition hover:bg-[#2a475e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          <Image
            src={steamLogo}
            alt=""
            aria-hidden
            width={512}
            height={512}
            className="h-5 w-5"
            priority
          />
          Войти через Steam
        </a>

      <p className="text-xs text-muted-foreground">
        Профиль создаётся со статусом «На рассмотрении». Доступ к внутренним
        разделам открывается после одобрения советом.
      </p>
    </div>
  );
}

function SignedIn({
  profile,
  canUseAdmin,
  isPending,
  onSignOut,
  onOpenPortal,
}: {
  profile: ProfileDTO;
  canUseAdmin: boolean;
  isPending: boolean;
  onSignOut: () => void;
  onOpenPortal: () => void;
}) {
  const status = STATUS_COPY[profile.status];
  const isApproved = profile.status === "approved";

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 rounded-xl border border-border bg-background/60 p-3">
        <Avatar className="h-12 w-12">
          <AvatarImage src={profile.avatarUrl} alt="" />
          <AvatarFallback>
            {(profile.persona || "С").slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>

        <div className="min-w-0 flex-1 space-y-1">
          <p className="truncate font-medium text-cloud">
            {profile.persona || "Без ника"}
          </p>
          <a
            href={steamProfileUrl(profile.steamId)}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate font-mono text-xs text-muted-foreground hover:text-primary"
          >
            SteamID64: {profile.steamId}
          </a>
          <div className="flex flex-wrap items-center gap-2 pt-0.5">
            <Badge variant={status.variant}>Статус: {status.label}</Badge>
            {profile.status === "approved"
              ? profile.roles.map((role) => (
                  <Badge key={role} variant="outline">
                    {ROLE_COPY[role]}
                  </Badge>
                ))
              : null}
          </div>
        </div>
      </div>

      {canUseAdmin ? (
        <DialogFooter className="gap-2 sm:justify-start">
          <a
            href="/admin"
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-full bg-primary px-5 py-2.5 font-medium text-primary-foreground transition hover:bg-primary/85"
          >
            <ShieldCheck className="h-4 w-4" aria-hidden />
            Панель администратора
          </a>
        </DialogFooter>
      ) : (
        <div className="space-y-3">
          <p className="flex items-start gap-2 rounded-lg border border-border bg-background/40 p-3 text-xs text-muted-foreground">
            <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" aria-hidden />
            <span>
              {profile.status === "rejected"
                ? "Профиль не состоит в партии: доступ к порталу и данным закрыт. Аккаунт Steam рабочий - заполните заявку заново, и решение снова примут люди."
                : "Разделы заблокированы до одобрения профиля. Сессия активна 24 часа с момента входа."}
            </span>
          </p>

          {/* {profile.status === "rejected" && (
            <a
              href="/join#application"
              className="flex w-full items-center justify-center gap-2 rounded-full border border-primary/50 bg-primary/10 px-5 py-2.5 font-medium text-primary transition hover:bg-primary/20"
            >
              Подать заявку заново
            </a>
          )} */}
        </div>
      )}

      {isApproved ? (
        <button
          type="button"
          onClick={onOpenPortal}
          className="flex w-full items-center justify-center gap-2.5 rounded-full border border-primary/50 bg-primary/10 px-5 py-2.5 font-medium text-primary transition hover:bg-primary/20"
        >
          <LayoutDashboard className="h-4 w-4" aria-hidden />
          Открыть портал
        </button>
      ) : null}

      <DialogFooter className="sm:justify-start">
        <button
          type="button"
          onClick={onSignOut}
          disabled={isPending}
          className="inline-flex items-center gap-2 rounded-full border border-border bg-card/60 px-4 py-2 text-sm text-muted-foreground transition hover:border-destructive/50 hover:text-destructive disabled:opacity-50"
        >
          <LogOut className="h-4 w-4" aria-hidden />
          {isPending ? "Выходим…" : "Выйти"}
        </button>
      </DialogFooter>
    </div>
  );
}
