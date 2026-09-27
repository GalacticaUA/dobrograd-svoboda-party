"use client";

import { useCallback, useState, useTransition } from "react";
import { Loader2, Plus, Save, Trash2, Users } from "lucide-react";
import { toast } from "sonner";

import { EmptyState, LoadingBlock, PageTitle, Panel } from "@/components/portal/primitives";
import { loadAvailability, loadAvailabilityMatrix, saveAvailability } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { can } from "@/lib/permissions";
import {
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  clockToMinutes,
  minutesToClock,
  type AvailabilityMatrixRow,
  type AvailabilitySlot,
} from "@/lib/portal/types";
import type { Role } from "@/types/party";

interface SlotDraft {
  fromMin: number;
  toMin: number;
}

type WeekDraft = SlotDraft[][];

/**
 * `text-clock` does not exist in this palette - the foreground token is
 * `text-cloud` - so it is defined once here instead of being repeated inline.
 */
const timeCls =
  "h-9 rounded-lg border border-border bg-background px-2 text-sm text-cloud outline-none focus:border-primary";

/**
 * When the member is free.
 *
 * Times are held as minutes from midnight rather than as "HH:MM" strings, because
 * the database stores integers: comparing two people for an overlap is then a
 * plain integer test, and there is no timezone or DST conversion anywhere in the
 * path. The `<input type="time">` is only ever a view onto that number.
 *
 * Staff get a read-only grid of everyone else's week underneath, which is the
 * actual reason this data exists - picking a date that most people are free.
 */
export function AvailabilityTab({ role }: { role: Role }) {
  const { data, error, pending, refresh } = useAsyncData<AvailabilitySlot[]>(loadAvailability);

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

  return (
    <div className="space-y-4">
      <AvailabilityForm initial={data ?? []} onSaved={refresh} />
      {can(role, "availability.viewAll") ? <AvailabilityMatrix /> : null}
    </div>
  );
}

/**
 * The editable week, split out from the loader for the same reason as the account
 * form: the draft is seeded from `initial` in a `useState` initialiser, which runs
 * on mount only. Rebuilding it from an effect on every `data` change would discard
 * the user's in-progress edits, because `refresh()` after a save produces a new
 * array object even when the contents are identical.
 */
function AvailabilityForm({
  initial,
  onSaved,
}: {
  initial: AvailabilitySlot[];
  onSaved: () => void;
}) {
  const [saving, startTransition] = useTransition();
  const [draft, setDraft] = useState<WeekDraft>(() => toWeekDraft(initial));
  const [dirty, setDirty] = useState(false);

  const addSlot = (weekday: number) => {
    setDraft((current) => {
      const next = current.map((day) => [...day]);
      const last = next[weekday][next[weekday].length - 1];
      const from = last ? Math.min(1440, last.toMin) : 9 * 60;
      const to = Math.min(1440, from + 120);
      if (to <= from) return current;
      next[weekday].push({ fromMin: from, toMin: to });
      return next;
    });
    setDirty(true);
  };

  const removeSlot = (weekday: number, index: number) => {
    setDraft((current) => {
      const next = current.map((day) => [...day]);
      next[weekday].splice(index, 1);
      return next;
    });
    setDirty(true);
  };

  const changeSlot = (weekday: number, index: number, field: "from" | "to", value: string) => {
    const minutes = clockToMinutes(value);
    if (minutes === null) return;
    setDraft((current) => {
      const next = current.map((day) => [...day]);
      const slot = next[weekday][index];
      if (!slot) return current;
      next[weekday][index] =
        field === "from" ? { ...slot, fromMin: minutes } : { ...slot, toMin: minutes };
      return next;
    });
    setDirty(true);
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const slots = draft.flatMap((day, weekday) =>
        day
          .filter((slot) => slot.toMin > slot.fromMin)
          .map((slot) => ({ weekday, fromMin: slot.fromMin, toMin: slot.toMin })),
      );
      const result = await saveAvailability(slots);
      if (result.ok) {
        toast.success("График сохранён");
        setDirty(false);
        onSaved();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <PageTitle
        title="График"
        sub="Отметьте интервалы, когда вы свободны. По этому графику ставятся сборы."
      />

      <div className="space-y-2">
        {WEEKDAY_LABELS.map((label, weekday) => (
          <Panel key={weekday} className="p-3 sm:p-4">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-sm font-medium text-cloud">
                <span className="text-muted-foreground sm:hidden">{WEEKDAY_SHORT[weekday]}</span>
                <span className="hidden sm:inline">{label}</span>
              </h3>
              <button
                type="button"
                onClick={() => addSlot(weekday)}
                className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-cloud transition hover:border-primary"
              >
                <Plus className="h-3 w-3" />
                Добавить
              </button>
            </div>

            {draft[weekday].length === 0 ? (
              <p className="text-xs text-muted-foreground">Не выбран ни один интервал.</p>
            ) : (
              <ul className="space-y-2">
                {draft[weekday].map((slot, index) => {
                  const invalid = slot.toMin <= slot.fromMin;
                  return (
                    <li key={index} className="flex items-center gap-2">
                      <input
                        type="time"
                        value={minutesToClock(slot.fromMin)}
                        onChange={(event) => changeSlot(weekday, index, "from", event.target.value)}
                        className={timeCls}
                      />
                      <span className="text-muted-foreground">—</span>
                      <input
                        type="time"
                        value={minutesToClock(slot.toMin)}
                        onChange={(event) => changeSlot(weekday, index, "to", event.target.value)}
                        className={timeCls}
                      />
                      <button
                        type="button"
                        onClick={() => removeSlot(weekday, index)}
                        aria-label="Удалить интервал"
                        className="ml-auto rounded-lg p-1.5 text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                      {invalid && (
                        <span className="text-xs text-destructive">конец раньше начала</span>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        ))}
      </div>

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={saving || !dirty}
          className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-5 text-sm font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {dirty ? "Сохранить график" : "График сохранён"}
        </button>
      </div>
    </form>
  );
}

/** Group the flat slot list into seven days, each ordered by start time. */
function toWeekDraft(slots: AvailabilitySlot[]): WeekDraft {
  return Array.from({ length: 7 }, (_, weekday) =>
    slots
      .filter((slot) => slot.weekday === weekday)
      .sort((a, b) => a.fromMin - b.fromMin)
      .map((slot) => ({ fromMin: slot.fromMin, toMin: slot.toMin })),
  );
}

/**
 * Read-only "who is free when" grid for staff.
 *
 * Rendered as horizontal day columns rather than a table so it stays legible on a
 * phone: a 7-column table with time ranges inside would need a horizontal scroll
 * to be read at all, whereas a per-day list wraps naturally.
 */
function AvailabilityMatrix() {
  const loader = useCallback(() => loadAvailabilityMatrix(), []);
  const { data, error, pending } = useAsyncData<AvailabilityMatrixRow[]>(loader, "matrix");

  if (pending) return <LoadingBlock label="Считаем занятость…" />;
  if (error) return <Panel><p className="text-sm text-muted-foreground">{error}</p></Panel>;

  const rows = data ?? [];
  if (rows.length === 0) {
    return <EmptyState title="Пока никого нет" hint="График появится, как только участники его заполнят." />;
  }

  return (
    <Panel>
      <h3 className="mb-1 flex items-center gap-2 font-display text-base text-cloud">
        <Users className="h-4 w-4 text-primary" />
        Кто свободен
      </h3>
      <p className="mb-3 text-xs text-muted-foreground">
        Считайте, сколько человек доступно в один и тот же интервал.
      </p>

      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.steamId} className="border-t border-border pt-3 first:border-0 first:pt-0">
            <p className="mb-1.5 text-sm text-cloud">
              {row.name}
              {row.status !== "approved" && (
                <span className="ml-2 text-xs text-muted-foreground">не одобрен</span>
              )}
            </p>
            {row.slots.length === 0 ? (
              <p className="text-xs text-muted-foreground">График не заполнен</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {row.slots.map((slot, index) => (
                  <li
                    key={index}
                    className="rounded-md border border-border px-2 py-0.5 text-xs text-clock"
                  >
                    {WEEKDAY_SHORT[slot.weekday]} {minutesToClock(slot.fromMin)}–{minutesToClock(slot.toMin)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </Panel>
  );
}
