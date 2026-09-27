"use client";

import { useState, useTransition } from "react";
import { Loader2, MessageSquarePlus, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { EmptyState, LoadingBlock, PageTitle, Panel, fieldCls } from "@/components/portal/primitives";
import { changeAppealReply, changeAppealStatus, loadAppeals, removeAppeal, submitAppeal } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { can, isAppealOpen } from "@/lib/permissions";
import { APPEAL_STATUS_LABELS, type AppealRecord, type AppealStatus } from "@/lib/portal/types";
import type { ProfileDTO } from "@/types/auth";

const STATUSES: AppealStatus[] = ["new", "in_review", "done", "rejected"];

const STATUS_STYLE: Record<AppealStatus, string> = {
  new: "bg-primary/15 text-primary",
  in_review: "bg-amber-500/15 text-amber-400",
  done: "bg-emerald-500/15 text-emerald-400",
  rejected: "bg-destructive/15 text-destructive",
};

export function AppealsTab({ profile }: { profile: ProfileDTO }) {
  const { data, error, pending, refresh } = useAsyncData<AppealRecord[]>(loadAppeals);
  const [composing, setComposing] = useState(false);

  if (pending) return <LoadingBlock />;
  if (error) {
    return (
      <Panel>
        <p className="text-sm text-muted-foreground">{error}</p>
        <button type="button" onClick={() => refresh()} className="mt-3 text-sm text-primary hover:underline">
          Повторить
        </button>
      </Panel>
    );
  }

  const appeals = data ?? [];

  return (
    <div className="space-y-4">
      <PageTitle
        title="Обращения"
        sub="Видны только участникам партии."
        action={
          <button
            type="button"
            onClick={() => setComposing((value) => !value)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm text-primary-foreground transition hover:bg-primary/90"
          >
            <MessageSquarePlus className="h-4 w-4" />
            {composing ? "Свернуть" : "Новое обращение"}
          </button>
        }
      />

      {composing && (
        <ComposeCard
          onDone={async () => {
            setComposing(false);
            await refresh();
          }}
        />
      )}

      {appeals.length === 0 ? (
        <EmptyState
          title="Обращений пока нет"
          hint=""
        />
      ) : (
        <ul className="space-y-3">
          {appeals.map((appeal) => (
            <AppealCard
              key={appeal.id}
              appeal={appeal}
              isAuthor={appeal.author === profile.steamId}
              role={profile.role}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ComposeCard({ onDone }: { onDone: () => Promise<void> }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [saving, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await submitAppeal({ title, body });
      if (result.ok) {
        toast.success("Обращение отправлено");
        setTitle("");
        setBody("");
        await onDone();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={submit}>
      <Panel className="space-y-3">
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Заголовок"
          maxLength={200}
          className={fieldCls}
        />
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="О чём обращение"
          rows={4}
          maxLength={5000}
          className={fieldCls}
        />
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
            Отправить
          </button>
        </div>
      </Panel>
    </form>
  );
}

function AppealCard({
  appeal,
  isAuthor,
  role,
  onChanged,
}: {
  appeal: AppealRecord;
  isAuthor: boolean;
  role: ProfileDTO["role"];
  onChanged: () => void;
}) {
  const [reply, setReply] = useState(appeal.staffReply ?? "");
  const [confirming, setConfirming] = useState(false);
  const [busy, startTransition] = useTransition();

  const isStaff = can(role, "appeal.deleteAny");
  // The author may withdraw an appeal only while it is still open; once it records
  // a decision it becomes part of the council's history.
  const canDelete = isStaff || (isAuthor && isAppealOpen(appeal.status));
  const canReply = can(role, "appeal.reply");

  const run = (task: () => Promise<{ ok: boolean; error?: string }>, okMessage: string) => {
    startTransition(async () => {
      const result = await task();
      if (result.ok) {
        toast.success(okMessage);
        setConfirming(false);
        onChanged();
      } else {
        toast.error(result.error ?? "Не удалось выполнить действие");
      }
    });
  };

  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-cloud">{appeal.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {appeal.authorName} ·{" "}
            {new Date(appeal.createdAt).toLocaleDateString("ru-RU", {
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
          </p>
        </div>
        <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${STATUS_STYLE[appeal.status]}`}>
          {APPEAL_STATUS_LABELS[appeal.status]}
        </span>
      </div>

      <p className="whitespace-pre-wrap text-sm text-muted-foreground">{appeal.body}</p>

      <div className="mt-3 border-t border-border pt-3">
        <p className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">Статус</p>
        <div className="flex flex-wrap gap-1.5">
          {STATUSES.map((status) => (
            <button
              key={status}
              type="button"
              disabled={busy || status === appeal.status}
              onClick={() => run(() => changeAppealStatus({ id: appeal.id, status }), "Статус обновлён")}
              className={`rounded-lg border px-2.5 py-1 text-xs transition ${
                status === appeal.status
                  ? "border-primary text-primary"
                  : "border-border text-muted-foreground hover:border-primary hover:text-cloud"
              } disabled:opacity-50`}
            >
              {APPEAL_STATUS_LABELS[status]}
            </button>
          ))}
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          По вашему решению статус может поставить любой участник.
        </p>
      </div>

      {canReply && (
        <div className="mt-3 border-t border-border pt-3">
          <label className="mb-1.5 block text-xs uppercase tracking-wide text-muted-foreground">
            Ответ сотрудника
          </label>
          <textarea
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            rows={2}
            maxLength={5000}
            className={fieldCls}
            placeholder="Виден автору обращения"
          />
          <div className="mt-2 flex justify-end">
            <button
              type="button"
              disabled={busy}
              onClick={() => run(() => changeAppealReply({ id: appeal.id, reply }), "Ответ сохранён")}
              className="rounded-lg border border-border px-3 py-1.5 text-xs text-cloud transition hover:border-primary disabled:opacity-60"
            >
              Сохранить ответ
            </button>
          </div>
        </div>
      )}

      {!canReply && appeal.staffReply && (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
          <p className="mb-1 text-xs uppercase tracking-wide text-primary">Ответ сотрудника</p>
          <p className="whitespace-pre-wrap text-sm text-cloud">{appeal.staffReply}</p>
        </div>
      )}

      {canDelete && (
        <div className="mt-3 flex justify-end">
          {confirming ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => removeAppeal(appeal.id), "Обращение удалено")}
                className="rounded-lg bg-destructive px-3 py-1.5 text-xs text-destructive-foreground disabled:opacity-60"
              >
                Удалить навсегда
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
              >
                Отмена
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Удалить
            </button>
          )}
        </div>
      )}
    </Panel>
  );
}
