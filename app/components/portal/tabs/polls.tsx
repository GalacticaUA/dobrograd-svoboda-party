"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, Plus, Trash2, Vote, X } from "lucide-react";
import { toast } from "sonner";

import { EmptyState, LoadingBlock, PageTitle, Panel, fieldCls } from "@/components/portal/primitives";
import { castVote, changePollStatus, loadPolls, removePoll, submitPoll } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { can, isPollOpen } from "@/lib/permissions";
import { POLL_STATUS_LABELS, type PollRecord } from "@/lib/portal/types";
import type { ProfileDTO } from "@/types/auth";

export function PollsTab({ profile }: { profile: ProfileDTO }) {
  const { data, error, pending, refresh } = useAsyncData<PollRecord[]>(loadPolls);
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

  const polls = data ?? [];

  return (
    <div className="space-y-4">
      <PageTitle
        title="Опросы"
        sub="Видны только участникам партии."
        action={
          <button
            type="button"
            onClick={() => setComposing((value) => !value)}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm text-primary-foreground transition hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            {composing ? "Свернуть" : "Новый опрос"}
          </button>
        }
      />

      {composing && <ComposePoll onDone={async () => { setComposing(false); await refresh(); }} />}

      {polls.length === 0 ? (
        <EmptyState title="Опросов пока нет" hint="Создайте первый - так вы сможете узнать мнение партии." />
      ) : (
        <ul className="space-y-3">
          {polls.map((poll) => (
            <PollCard
              key={poll.id}
              poll={poll}
              isAuthor={poll.author === profile.steamId}
              role={profile.role}
              onChanged={refresh}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function ComposePoll({ onDone }: { onDone: () => Promise<void> }) {
  const [question, setQuestion] = useState("");
  const [description, setDescription] = useState("");
  const [multiple, setMultiple] = useState(false);
  const [options, setOptions] = useState<string[]>(["", ""]);
  const [saving, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await submitPoll({ question, description, multiple, options });
      if (result.ok) {
        toast.success("Опрос создан");
        setQuestion("");
        setDescription("");
        setOptions(["", ""]);
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
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Вопрос"
          maxLength={300}
          className={fieldCls}
        />
        <input
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Пояснение (необязательно)"
          maxLength={1000}
          className={fieldCls}
        />

        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Варианты</p>
          {options.map((option, index) => (
            <div key={index} className="flex items-center gap-2">
              <input
                value={option}
                onChange={(event) =>
                  setOptions((current) => current.map((o, i) => (i === index ? event.target.value : o)))
                }
                placeholder={`Вариант ${index + 1}`}
                maxLength={200}
                className={fieldCls}
              />
              {options.length > 2 && (
                <button
                  type="button"
                  onClick={() => setOptions((current) => current.filter((_, i) => i !== index))}
                  aria-label="Убрать вариант"
                  className="shrink-0 rounded-lg p-2 text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
          ))}
          {options.length < 12 && (
            <button
              type="button"
              onClick={() => setOptions((current) => [...current, ""])}
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              <Plus className="h-3 w-3" />
              Добавить вариант
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMultiple((value) => !value)}
          className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left text-sm transition hover:border-primary"
        >
          <span className="text-clock">
            {multiple ? "Можно выбрать несколько вариантов" : "Можно выбрать только один вариант"}
          </span>
          {multiple ? (
            <Check className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <X className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
        </button>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Vote className="h-4 w-4" />}
            Создать
          </button>
        </div>
      </Panel>
    </form>
  );
}

function PollCard({
  poll,
  isAuthor,
  role,
  onChanged,
}: {
  poll: PollRecord;
  isAuthor: boolean;
  role: ProfileDTO["role"];
  onChanged: () => void;
}) {
  const initial = poll.options.filter((option) => option.ownVote).map((option) => option.id);
  const [picked, setPicked] = useState<string[]>(initial);
  const [busy, startTransition] = useTransition();

  const open = isPollOpen(poll.status);
  const isStaff = can(role, "poll.deleteAny");
  const canDelete = isStaff || (isAuthor && open);

  const toggle = (optionId: string) => {
    setPicked((current) => {
      if (poll.multiple) {
        return current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId];
      }
      return current[0] === optionId ? [] : [optionId];
    });
  };

  const run = (task: () => Promise<{ ok: boolean; error?: string }>, okMessage: string) => {
    startTransition(async () => {
      const result = await task();
      if (result.ok) {
        toast.success(okMessage);
        onChanged();
      } else {
        toast.error(result.error ?? "Не удалось выполнить действие");
      }
    });
  };

  const maxVotes = Math.max(1, ...poll.options.map((option) => option.votes ?? 0));

  return (
    <Panel>
      <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-cloud">{poll.question}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {poll.authorName} · {poll.multiple ? "несколько вариантов" : "один вариант"}
          </p>
        </div>
        <span
          className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${
            open ? "bg-primary/15 text-primary" : "bg-muted-foreground/15 text-muted-foreground"
          }`}
        >
          {POLL_STATUS_LABELS[poll.status]}
        </span>
      </div>

      {poll.description && (
        <p className="mb-3 whitespace-pre-wrap text-sm text-muted-foreground">{poll.description}</p>
      )}

      <ul className="space-y-2">
        {poll.options.map((option) => {
          const votes = option.votes ?? 0;
          const share = poll.voterCount > 0 ? Math.round((votes / poll.voterCount) * 100) : 0;
          const selected = picked.includes(option.id);

          return (
            <li key={option.id}>
              <button
                type="button"
                disabled={!open || busy}
                onClick={() => toggle(option.id)}
                className={`relative w-full overflow-hidden rounded-lg border px-3 py-2.5 text-left transition ${
                  selected ? "border-primary" : "border-border"
                } disabled:cursor-default`}
              >
                <span
                  className="absolute inset-y-0 left-0 bg-primary/10 transition-all"
                  style={{ width: `${(votes / maxVotes) * 100}%` }}
                />
                <span className="relative flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-2 text-sm text-clock">
                    {open && (
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${
                          selected ? "border-primary bg-primary text-primary-foreground" : "border-border"
                        }`}
                      >
                        {selected && <Check className="h-3 w-3" />}
                      </span>
                    )}
                    <span className="truncate">{option.label}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {votes} · {share}%
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <p className="mt-2 text-xs text-muted-foreground">
        Проголосовали: {poll.voterCount}
      </p>

      {open && (
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            disabled={busy || picked.length === 0}
            onClick={() => run(() => castVote({ pollId: poll.id, optionIds: picked }), "Голос сохранён")}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
          >
            {initial.length > 0 ? "Изменить голос" : "Проголосовать"}
          </button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-2 border-t border-border pt-3">
        {can(role, "poll.close") && (
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(
                () => changePollStatus({ pollId: poll.id, status: open ? "closed" : "open" }),
                open ? "Опрос закрыт" : "Опрос снова открыт",
              )
            }
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud"
          >
            {open ? "Закрыть опрос" : "Открыть опрос"}
          </button>
        )}
        {canDelete && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => removePoll(poll.id), "Опрос удалён")}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive hover:text-destructive"
          >
            Удалить
          </button>
        )}
      </div>
    </Panel>
  );
}
