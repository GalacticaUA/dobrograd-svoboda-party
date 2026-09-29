"use client";

import { useState, useTransition } from "react";
import {
  CalendarPlus,
  CheckCheck,
  Clock,
  Loader2,
  MapPin,
  Pencil,
  RotateCcw,
  Save,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState, LoadingBlock, PageTitle, Panel, fieldCls } from "@/components/portal/primitives";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  loadDeletedEvents,
  loadEvents,
  removeEvent,
  restoreEventById,
  saveAttendance,
  saveEvent,
  setRsvp,
} from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import {
  EVENT_DESCRIPTION_MAX,
  EVENT_TITLE_MAX,
  eventDurationHours,
} from "@/lib/portal/event-state";
import type {
  AttendanceInput,
  EventRecord,
  EventState,
  EventUpsertInput,
  EventWithAttendance,
} from "@/lib/portal/types";
import type { ProfileDTO } from "@/types/auth";
import { useCan } from "@/components/portal/permissions";

/** How a state is labelled. Keyed off the clock, not `status` - see EventState. */
const STATE_LABELS: Record<EventState, string> = {
  draft: "Черновик",
  upcoming: "Будет",
  live: "Идёт",
  past: "Завершено",
};

const STATE_CLASSES: Record<EventState, string> = {
  draft: "bg-amber-500/15 text-amber-400",
  upcoming: "bg-primary/15 text-primary",
  live: "bg-emerald-500/15 text-emerald-400",
  past: "bg-muted-foreground/15 text-muted-foreground",
};

/** How many declines the compact card shows before it defers to the dialog. */
const DECLINES_ON_CARD = 3;

/** Ceiling for the hours slider when the event has no end time to derive one from. */
const UNBOUNDED_HOURS_CAP = 12;

/**
 * The schedule.
 *
 * Members see the list read-only and can only join or leave an open event. Staff
 * additionally get the create/edit form, the closing dialog and delete.
 *
 * The cards are deliberately compact. Everything about an event is reachable by
 * opening it, because a list of fifteen meetings with full descriptions, a chip
 * per attendee and a per-person decline reason each is a wall nobody scrolls down -
 * and the one thing that does need to be visible without a click is whether you
 * are going.
 */
export function ScheduleTab({ profile }: { profile: ProfileDTO }) {
  const { data, error, pending, refresh } = useAsyncData<EventWithAttendance[]>(loadEvents);
  const [editing, setEditing] = useState<EventRecord | null>(null);
  const [creating, setCreating] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  // Three distinct questions, previously collapsed into one `isStaff` flag that
  // meant all three at once:
  //   mayCreate     - may I schedule anything at all
  //   mayEditAny    - may I change somebody else's event
  //   mayDeleteAny  - may I hide anybody's event
  // A row the viewer created is editable and deletable on `mayCreate` alone, which
  // is what lets a plain member keep their own schedule without becoming staff.
  const mayCreate = useCan("event.create");
  const mayEditAny = useCan("event.editAny");
  const mayDeleteAny = useCan("event.deleteAny");
  const mySteamId = profile.steamId;

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

  const events = data ?? [];

  return (
    <div className="space-y-4">
      <PageTitle
        title="Расписание"
        sub="События и кто на них записан."
        action={
          mayCreate ? (
            <button
              type="button"
              onClick={() => {
                setCreating((value) => !value);
                setEditing(null);
              }}
              className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-sm text-primary-foreground transition hover:bg-primary/90"
            >
              <CalendarPlus className="h-4 w-4" />
              {creating ? "Свернуть" : "Новое событие"}
            </button>
          ) : undefined
        }
      />

      {mayCreate && (creating || editing) && (
        <EventForm
          event={editing}
          onDone={async () => {
            setCreating(false);
            setEditing(null);
            await refresh();
          }}
        />
      )}

      {events.length === 0 ? (
        <EmptyState
          title="Событий пока нет"
          hint={mayCreate ? "Создайте первое мероприятие." : "Как только партия назначит сбор, оно появится здесь."}
        />
      ) : (
        <ul className="space-y-3">
          {events.map((event) => (
            <EventCard
              key={event.id}
              event={event}
              profile={profile}
              mayCreate={mayCreate}
              mayEditAny={mayEditAny}
              mayDeleteAny={mayDeleteAny}
              viewerSteamId={mySteamId}
              onChanged={refresh}
              onEdit={() => {
                setEditing(event);
                setCreating(false);
              }}
            />
          ))}
        </ul>
      )}

      {mayDeleteAny && (
        <div className="border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setShowDeleted((value) => !value)}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-cloud"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Удалённые мероприятия
          </button>
          {/* Mounted only when open: `useAsyncData` has no `enabled` gate and always
              fires on mount, so keeping it mounted would fetch the archive on every
              visit to the tab whether anyone asked for it or not. */}
          {showDeleted && <DeletedEvents onRestored={refresh} />}
        </div>
      )}
    </div>
  );
}

/**
 * Hidden events, with a way back.
 *
 * Delete is soft, so this is the only route to a meeting that was removed by
 * mistake - which is the whole reason the operation hides instead of dropping the
 * row. The restore itself only needs `event.edit`; being able to see that there is
 * something to restore is part of the delete right.
 */
function DeletedEvents({ onRestored }: { onRestored: () => Promise<void> | void }) {
  const { data, error, pending, refresh } = useAsyncData<EventWithAttendance[]>(loadDeletedEvents);
  const [busy, startTransition] = useTransition();

  const events = data ?? [];

  const restore = (event: EventWithAttendance) => {
    startTransition(async () => {
      const result = await restoreEventById(event.id);
      if (result.ok) {
        toast.success("Мероприятие восстановлено");
        await refresh();
        await onRestored();
      } else {
        toast.error(result.error ?? "Не удалось восстановить");
      }
    });
  };

  if (pending) return <p className="mt-2 text-xs text-muted-foreground">Загрузка…</p>;
  if (error) return <p className="mt-2 text-xs text-destructive">{error}</p>;
  if (events.length === 0) return <p className="mt-2 text-xs text-muted-foreground">Ничего не удалено.</p>;

  return (
    <ul className="mt-2 space-y-2">
      {events.map((event) => (
        <li
          key={event.id}
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card/50 px-3 py-2"
        >
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {event.title}
            {event.attendance.length > 0 && (
              <span className="ml-2 text-muted-foreground/70">часов учтено: {event.totalHours}</span>
            )}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => restore(event)}
            className="inline-flex items-center gap-1 rounded-lg border border-border px-2 py-1 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud disabled:opacity-60"
          >
            <RotateCcw className="h-3 w-3" />
            Восстановить
          </button>
        </li>
      ))}
    </ul>
  );
}

/* -------------------------------------------------------------------------- */

function EventForm({ event, onDone }: { event: EventRecord | null; onDone: () => Promise<void> }) {
  const [title, setTitle] = useState(event?.title ?? "");
  const [description, setDescription] = useState(event?.description ?? "");
  const [location, setLocation] = useState(event?.location ?? "");
  const [startsAt, setStartsAt] = useState(
    event ? toLocalInput(event.startsAt) : toLocalInput(new Date().toISOString()),
  );
  const [endsAt, setEndsAt] = useState(event?.endsAt ? toLocalInput(event.endsAt) : "");
  const [rsvpLimit, setRsvpLimit] = useState(event?.rsvpLimit ? String(event.rsvpLimit) : "");
  const [isPublished, setIsPublished] = useState(event?.isPublished ?? true);
  const [trackHours, setTrackHours] = useState(event?.trackHours ?? true);
  const [status, setStatus] = useState<EventUpsertInput["status"]>(event?.status ?? "open");
  const [saving, startTransition] = useTransition();

  const submit = (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    startTransition(async () => {
      const result = await saveEvent({
        id: event?.id,
        title,
        description,
        location,
        startsAt: new Date(startsAt).toISOString(),
        endsAt: endsAt ? new Date(endsAt).toISOString() : null,
        rsvpLimit: rsvpLimit ? Number(rsvpLimit) : null,
        isPublished,
        trackHours,
        requireRsvp: true,
        status,
      });
      if (result.ok) {
        toast.success(event ? "Событие обновлено" : "Событие создано");
        await onDone();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={submit}>
      <Panel className="space-y-3">
        <div>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Название"
            maxLength={EVENT_TITLE_MAX}
            className={fieldCls}
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">
            {title.length}/{EVENT_TITLE_MAX}
          </p>
        </div>
        <div>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Описание"
            rows={2}
            maxLength={EVENT_DESCRIPTION_MAX}
            className={fieldCls}
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">
            {description.length}/{EVENT_DESCRIPTION_MAX}
          </p>
        </div>
        <input
          value={location}
          onChange={(e) => setLocation(e.target.value)}
          placeholder="Место"
          maxLength={200}
          className={fieldCls}
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm text-clock">
            Начало
            <input
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className={`${fieldCls} mt-1`}
              required
            />
          </label>
          <label className="text-sm text-clock">
            Окончание
            <input
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className={`${fieldCls} mt-1`}
            />
          </label>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label className="text-sm text-clock">
            Мест (пусто - без ограничений)
            <input
              type="number"
              min={1}
              value={rsvpLimit}
              onChange={(e) => setRsvpLimit(e.target.value)}
              className={`${fieldCls} mt-1`}
            />
          </label>
          <label className="text-sm text-clock">
            Состояние
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as EventUpsertInput["status"])}
              className={`${fieldCls} mt-1`}
            >
              <option value="draft">Черновик - не виден участникам</option>
              <option value="open">Открыто - идёт запись</option>
              <option value="finished">Завершено - часы учтены</option>
            </select>
          </label>
        </div>

        <ToggleRow
          label="Опубликовано"
          hint="Черновики видны только сотрудникам"
          on={isPublished}
          onToggle={() => setIsPublished((v) => !v)}
        />
        <ToggleRow
          label="Учитывать часы"
          hint="Выключите для событий без учёта работы"
          on={trackHours}
          onToggle={() => setTrackHours((v) => !v)}
        />

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-4 text-sm text-primary-foreground disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Сохранить
          </button>
        </div>
      </Panel>
    </form>
  );
}

function ToggleRow({
  label,
  hint,
  on,
  onToggle,
}: {
  label: string;
  hint: string;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 text-left transition hover:border-primary"
    >
      <span>
        <span className="block text-sm text-clock">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
      </span>
      {on ? (
        <CheckCheck className="h-4 w-4 shrink-0 text-primary" />
      ) : (
        <X className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );
}

/* -------------------------------------------------------------------------- */

function EventCard({
  event,
  profile,
  mayCreate,
  mayEditAny,
  mayDeleteAny,
  viewerSteamId,
  onChanged,
  onEdit,
}: {
  event: EventWithAttendance;
  profile: ProfileDTO;
  mayCreate: boolean;
  mayEditAny: boolean;
  mayDeleteAny: boolean;
  viewerSteamId: string;
  onChanged: () => void;
  onEdit: () => void;
}) {
  const [busy, startTransition] = useTransition();
  const [closing, setClosing] = useState(false);
  const [details, setDetails] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [removing, setRemoving] = useState(false);

  // Per row, not per viewer. These two are the whole point of the role system for
  // this tab: a member with `event.create` keeps full control of the meetings they
  // called, and nothing over anybody else's. `createdBy` is null for events written
  // before the column existed, and those are staff-only - a null author is not a
  // claim of ownership. The same pairing is evaluated again server-side.
  const isAuthor = event.createdBy != null && event.createdBy === viewerSteamId;
  const canEdit = mayEditAny || (isAuthor && mayCreate);
  const canDelete = mayDeleteAny || (isAuthor && mayCreate);
  // Closing an event and crediting hours is a moderation act on the party's record,
  // never a self-service one, so it stays a flat permission with no own/any variant.
  const mayClose = useCan("event.close");

  const rsvped = event.ownStatus === "rsvp" || event.ownStatus === "attended";
  // Signup is open by policy (`status`) and by clock. The clock half matters more
  // than it looks: `status` only flips when staff remember to close an event, so
  // without it a meeting from last week keeps offering a "записаться" button that
  // the DAL would reject anyway.
  const started = event.state === "past" || event.state === "live";
  const canJoin = event.status === "open" && !started;

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

  const shownDeclines = event.declines.slice(0, DECLINES_ON_CARD);
  const hiddenDeclines = event.declines.length - shownDeclines.length;

  return (
    <Panel>
      {/* The whole card opens the details. `role="button"` with a keyboard handler
          rather than a nested <button>, because the action row inside it is made of
          real buttons and nesting those would make the card's own click ambiguous. */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => setDetails(true)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setDetails(true);
          }
        }}
        className="cursor-pointer rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="font-medium text-cloud">{event.title}</h3>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Clock className="h-3 w-3" />
                {new Date(event.startsAt).toLocaleString("ru-RU", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </span>
              {event.location && (
                <span className="inline-flex items-center gap-1">
                  <MapPin className="h-3 w-3" />
                  {event.location}
                </span>
              )}
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" />
                {event.attendance.length}
                {event.rsvpLimit ? ` / ${event.rsvpLimit}` : ""}
              </span>
            </p>
          </div>
          <span
            className={`shrink-0 rounded-full px-2.5 py-1 text-xs ${STATE_CLASSES[event.state]}`}
          >
            {STATE_LABELS[event.state]}
          </span>
        </div>

        {event.description && (
          <p className="mb-3 line-clamp-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {event.description}
          </p>
        )}

        {event.attendance.length > 0 && (
          <p className="mb-2 text-xs text-muted-foreground">
            <span className="uppercase tracking-wide">
              {event.state === "past" ? "Отработали" : "Записались"}
            </span>
            <span className="ml-2 text-muted-foreground/80">
              {event.attendance.length}
              {event.state === "past" && event.absentCount > 0 && `, не было ${event.absentCount}`}
            </span>
          </p>
        )}

        {event.declines.length > 0 && (
          <div className="mb-2">
            <p className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Отписались
            </p>
            <ul className="space-y-0.5">
              {shownDeclines.map((decline) => (
                <li key={decline.steamId} className="truncate text-xs text-muted-foreground">
                  <span className="text-cloud/80">{decline.name}</span>
                  {decline.reason && (
                    <span className="text-muted-foreground/70"> - {decline.reason}</span>
                  )}
                </li>
              ))}
              {hiddenDeclines > 0 && (
                <li className="text-xs text-muted-foreground/70">и ещё {hiddenDeclines}</li>
              )}
            </ul>
          </div>
        )}

        {event.state === "past" && event.totalHours > 0 && (
          <p className="mb-2 text-sm text-cloud">
            Всего отработано: <span className="font-display font-bold">{event.totalHours} ч</span>
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
        {canJoin && !rsvped && (
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => setRsvp({ eventId: event.id, attending: true }), "Вы записаны")}
            className="rounded-lg bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
          >
            Записаться
          </button>
        )}
        {canJoin && rsvped && profile.status === "approved" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => setLeaving(true)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive hover:text-destructive"
          >
            Отписаться
          </button>
        )}
        {rsvped && <span className="text-xs text-primary">вы записаны</span>}

        {canEdit && (
          <div className="ml-auto flex gap-2">
            <button
              type="button"
              onClick={onEdit}
              className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud"
            >
              <Pencil className="h-3.5 w-3.5" />
              Изменить
            </button>
            {mayClose && (
              <button
                type="button"
                onClick={() => setClosing((value) => !value)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud"
              >
                <CheckCheck className="h-3.5 w-3.5" />
                {event.status === "finished" ? "Исправить часы" : "Завершить"}
              </button>
            )}
            {canDelete && (
              <button
                type="button"
                onClick={() => setRemoving(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Удалить
              </button>
            )}
          </div>
        )}
      </div>

      {leaving && (
        <UnsubscribeDialog
          event={event}
          onClose={() => setLeaving(false)}
          onDone={() => {
            setLeaving(false);
            onChanged();
          }}
        />
      )}

      {removing && (
        <DeleteEventDialog
          event={event}
          onClose={() => setRemoving(false)}
          onDone={() => {
            setRemoving(false);
            onChanged();
          }}
        />
      )}

      {details && (
        <EventDetailsDialog event={event} canSeeReasons={mayEditAny} onClose={() => setDetails(false)} />
      )}

      {closing && (
        <CloseEventDialog
          event={event}
          onClose={() => setClosing(false)}
          onSaved={() => {
            setClosing(false);
            onChanged();
          }}
        />
      )}
    </Panel>
  );
}

/**
 * The unsubscribe prompt.
 *
 * A textarea rather than a select of canned reasons. The reasons people step off a
 * meeting for are not a small set - illness, a shift at work, a train that does not
 * run that night, "передумал" - and forcing them into three radio buttons produces
 * noise, not information. The field is required because the DAL refuses a blank
 * one; this only stops the user finding out by being told off.
 */
function UnsubscribeDialog({
  event,
  onClose,
  onDone,
}: {
  event: EventWithAttendance;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [saving, startTransition] = useTransition();

  const trimmed = reason.trim();
  const tooLong = trimmed.length > 100;

  const submit = (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    if (!trimmed || tooLong) return;

    startTransition(async () => {
      const result = await setRsvp({ eventId: event.id, attending: false, reason: trimmed });
      if (result.ok) {
        toast.success("Вы отписались");
        onDone();
      } else {
        toast.error(result.error ?? "Не удалось отписаться");
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4"
    >
      <h4 className="font-display text-sm text-cloud">Отписаться от «{event.title}»</h4>
      <p className="mt-1 text-xs text-muted-foreground">
        Напишите причину - её увидят только сотрудники. Это поможет понять, стоит ли
        переносить встречу.
      </p>

      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={3}
        maxLength={100}
        placeholder="Например: не смог прийти и причину не указал, заболел, передумал, не успеваю, не хочу"
        className="mt-2 w-full resize-y rounded-lg border border-border bg-background px-2.5 py-2 text-sm text-clock outline-none placeholder:text-muted-foreground/60 focus:border-primary"
      />

      {tooLong && (
        <p className="mt-1 text-xs text-destructive">Не больше 500 символов.</p>
      )}

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={saving || !trimmed || tooLong}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <X className="h-3.5 w-3.5" />}
          Отписаться
        </button>
      </div>
    </form>
  );
}

/**
 * Delete confirmation.
 *
 * The consequences are spelled out rather than implied. Delete is a hide, so the
 * hours are safe 0 but a reader who assumes "удалить" erases the record of a shift
 * somebody worked will not read that, and the audit log will not help them.
 */
function DeleteEventDialog({
  event,
  onClose,
  onDone,
}: {
  event: EventWithAttendance;
  onClose: () => void;
  onDone: () => void;
}) {
  const [saving, startTransition] = useTransition();

  const submit = (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    startTransition(async () => {
      const result = await removeEvent(event.id);
      if (result.ok) {
        toast.success("Мероприятие удалено");
        onDone();
      } else {
        toast.error(result.error ?? "Не удалось удалить мероприятие");
      }
    });
  };

  return (
    <form
      onSubmit={submit}
      className="mt-3 rounded-xl border border-destructive/40 bg-destructive/5 p-3 sm:p-4"
    >
      <h4 className="font-display text-sm text-cloud">Удалить «{event.title}»?</h4>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        <li>Событие исчезнет из расписания и с публичной страницы.</li>
        {event.attendance.length > 0 && (
          <li>
            Учёт присутствия и {event.totalHours > 0 ? `${event.totalHours} ч ` : ""}
            начисленных часов сохранится - их можно вернуть через «Восстановить».
          </li>
        )}
        {event.declines.length > 0 && (
          <li>Причины отписок ({event.declines.length}) сохранятся.</li>
        )}
      </ul>

      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-destructive px-4 py-1.5 text-xs text-destructive-foreground disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
          Удалить
        </button>
      </div>
    </form>
  );
}

/**
 * Everything about one event, on demand.
 *
 * The card shows counts and a couple of decline reasons; this is where the full
 * description, the complete attendance with hours and the complete decline list
 * live. It is a Radix dialog rendered as a sibling of the portal dialog's own
 * content, so it portals to `body` and stacks above rather than nesting a focus
 * trap inside another one.
 *
 * `canSeeReasons` is advisory only - the DAL has already stripped the reason
 * strings for anyone who is not staff, so a non-staff caller would see bare names
 * even if this flag were wrong.
 */
function EventDetailsDialog({
  event,
  canSeeReasons,
  onClose,
}: {
  event: EventWithAttendance;
  canSeeReasons: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="border-border bg-card w-full max-w-[95vw] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-display text-base text-cloud ">{event.title}</DialogTitle>
          <DialogDescription className="flex flex-wrap items-center gap-2">
            <span
              className={`rounded-full px-2 py-0.5 text-xs ${STATE_CLASSES[event.state]}`}
            >
              {STATE_LABELS[event.state]}
            </span>
            <span>
              {new Date(event.startsAt).toLocaleString("ru-RU", {
                day: "numeric",
                month: "long",
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pr-1">
          {event.description && (
            <p className="break-words whitespace-pre-wrap [overflow-wrap:anywhere] text-sm leading-relaxed text-muted-foreground ">
              {event.description}
            </p>
          )}

          {event.location && (
            <p className="text-xs text-muted-foreground">
              Место: <span className="text-cloud">{event.location}</span>
            </p>
          )}

          {event.attendance.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                {event.state === "past" ? "Отработали" : "Записались"}
              </p>
              <ul className="space-y-0.5">
                {event.attendance.map((entry) => (
                  <li key={entry.steamId} className="text-sm text-cloud">
                    {entry.name}
                    {entry.status === "attended" && entry.hours > 0 && (
                      <span className="text-muted-foreground"> · {entry.hours} ч</span>
                    )}
                    {entry.status === "absent" && (
                      <span className="text-destructive"> · не был</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {event.declines.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs uppercase tracking-wide text-muted-foreground">
                Отписались
              </p>
              <ul className="space-y-1">
                {event.declines.map((decline) => (
                  <li key={decline.steamId} className="text-sm">
                    <span className="text-cloud">{decline.name}</span>
                    {decline.reason ? (
                      <span className="text-muted-foreground"> - {decline.reason}</span>
                    ) : (
                      !canSeeReasons && (
                        <span className="text-muted-foreground/60"> - причина скрыта</span>
                      )
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {event.totalHours > 0 && (
            <p className="text-sm text-cloud">
              Всего отработано: <span className="font-display font-bold">{event.totalHours} ч</span>
              {event.absentCount > 0 && (
                <span className="ml-2 text-xs text-muted-foreground">
                  отсутствовали: {event.absentCount}
                </span>
              )}
            </p>
          )}
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
          >
            Закрыть
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The closing dialog.
 *
 * Seeding the rows from everyone who RSVP'd is deliberate: the people who need
 * marking are exactly those who said they were coming. Anyone still on `rsvp`
 * after saving is dropped by the DAL rather than left at zero hours, so the absent
 * count stays honest instead of counting people who were never recorded.
 *
 * Hours are edited through a slider and a number field bound to the same value.
 * The slider's ceiling is the event's own duration, because that is the only number
 * that can catch a typo - typing 14 into a meeting that ran from 18:00 to 20:00 is
 * always wrong, and a bounded control makes it visibly impossible. The number field
 * stays because half the entries are exact ("she left an hour early") and typing
 * "1.5" is faster than dragging a thumb to the right tick.
 */
function CloseEventDialog({
  event,
  onClose,
  onSaved,
}: {
  event: EventWithAttendance;
  onClose: () => void;
  onSaved: () => void;
}) {
  const duration = eventDurationHours(event.startsAt, event.endsAt);
  // An event with no end time has no duration to cap against, so it gets a flat
  // ceiling rather than an unbounded slider nobody can drag sensibly.
  const maxHours = duration > 0 ? Math.ceil(duration * 2) / 2 : UNBOUNDED_HOURS_CAP;
  // Default to the whole event: somebody marked "был" usually worked the shift they
  // signed up for, and the old flat 3 was a guess that was wrong more often than not.
  const defaultHours = duration > 0 ? maxHours : 3;

  const [rows, setRows] = useState<Record<string, AttendanceInput>>(() =>
    Object.fromEntries(
      event.attendance.map((entry) => [
        entry.steamId,
        {
          steamId: entry.steamId,
          status: entry.status === "rsvp" ? ("attended" as const) : entry.status,
          hours: entry.hours,
          note: entry.note ?? "",
        },
      ]),
    ),
  );
  const [saving, startTransition] = useTransition();

  const total = Object.values(rows).reduce(
    (sum, row) => sum + (row.status === "attended" ? row.hours : 0),
    0,
  );
  const absent = Object.values(rows).filter((row) => row.status === "absent").length;

  const update = (steamId: string, patch: Partial<AttendanceInput>) => {
    setRows((current) => ({ ...current, [steamId]: { ...current[steamId], ...patch } }));
  };

  const submit = (formEvent: React.FormEvent) => {
    formEvent.preventDefault();
    startTransition(async () => {
      const result = await saveAttendance({ eventId: event.id, rows: Object.values(rows), totalHours: total });
      if (result.ok) {
        toast.success("Мероприятие закрыто, часы записаны");
        onSaved();
      } else {
        toast.error(result.error);
      }
    });
  };

  if (event.attendance.length === 0) {
    return (
      <Panel className="mt-3">
        <p className="text-sm text-muted-foreground">
          На событие никто не записался, записывать нечего.
        </p>
        <button type="button" onClick={onClose} className="mt-2 text-sm text-primary hover:underline">
          Закрыть
        </button>
      </Panel>
    );
  }

  return (
    <form onSubmit={submit} className="mt-3 rounded-xl border border-primary/30 bg-primary/5 p-3 sm:p-4">
      <h4 className="mb-3 font-display text-sm text-cloud">
        {event.status === "finished" ? "Исправить учёт" : "Завершить мероприятие"}
      </h4>

      <ul className="mb-3 space-y-2">
        {Object.values(rows).map((row) => {
          const name = event.attendance.find((entry) => entry.steamId === row.steamId)?.name ?? row.steamId;
          return (
            <li key={row.steamId} className="rounded-lg border border-border bg-card p-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm text-cloud">{name}</span>

                <select
                  value={row.status}
                  onChange={(e) =>
                    update(row.steamId, {
                      status: e.target.value as AttendanceInput["status"],
                      hours: e.target.value === "attended" && row.hours === 0 ? defaultHours : row.hours,
                    })
                  }
                  className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-clock outline-none focus:border-primary"
                >
                  <option value="attended">был</option>
                  <option value="absent">не был</option>
                </select>

                {row.status === "attended" && event.trackHours && (
                  <div className="flex w-full items-center gap-2 pt-1 sm:w-auto sm:pt-0">
                    <input
                      type="range"
                      min={0}
                      max={maxHours}
                      step={0.5}
                      value={Math.min(row.hours, maxHours)}
                      onChange={(e) => update(row.steamId, { hours: Number(e.target.value) })}
                      aria-label={`Часы: ${name}`}
                      className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-border accent-primary sm:w-32 sm:flex-none"
                    />
                    <label className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <input
                        type="number"
                        min={0}
                        max={maxHours}
                        step={0.5}
                        value={row.hours}
                        onChange={(e) => update(row.steamId, { hours: Number(e.target.value) })}
                        className="h-8 w-16 rounded-lg border border-border bg-background px-2 text-clock outline-none focus:border-primary"
                      />
                      ч
                    </label>
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mb-3 text-sm text-clock">
        Всего: <span className="font-display font-bold">{total} ч</span>
        {absent > 0 && <span className="ml-2 text-xs text-muted-foreground">не было: {absent}</span>}
      </p>

      <div className="flex flex-wrap justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={saving}
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-1.5 text-xs text-primary-foreground disabled:opacity-60"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Записать часы
        </button>
      </div>
    </form>
  );
}

/**
 * "YYYY-MM-DDTHH:mm" in the *browser's* timezone.
 *
 * `datetime-local` inputs expect a local wall-clock string, while the database
 * stores UTC. Slicing an ISO string would silently shift the event by the
 * browser's UTC offset, so the round trip goes through Date.
 */
function toLocalInput(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
