"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Eye, EyeOff, ExternalLink, Loader2, MapPin, Save, Trash2, ZoomIn, ZoomOut } from "lucide-react";
import { toast } from "sonner";

import { EmptyState, LoadingBlock, PageTitle, Panel, fieldCls } from "@/components/portal/primitives";
import { loadWorkPoints, removeWorkPoint, saveWorkPoint } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { can } from "@/lib/permissions";
import {
  WORK_POINT_KIND_LABELS,
  WORK_POINT_STATUS_LABELS,
  type WorkPointKind,
  type WorkPointRecord,
  type WorkPointStatus,
} from "@/lib/portal/types";
import type { ProfileDTO } from "@/types/auth";
import mapImage from "@/assets/map.png";

const MIN_SCALE = 2;
const MAX_SCALE = 8;

/**
 * Zoom the map opens at: 500%.
 *
 * The map is a 4097px image of a real district, and at 100% the whole of it
 * shrinks to the size of the frame, where the pins are a few pixels across and
 * the street names are unreadable. Starting zoomed in makes the tab immediately
 * useful - you land on the part of the map at working size and pan from there.
 *
 * Kept separate from `MIN_SCALE`/`MAX_SCALE` so the opening zoom and the range it
 * may be changed to are two independent decisions.
 */
const DEFAULT_SCALE = 5;

/**
 * Movement below this many pixels, in any direction, counts as a click rather than
 * a drag. Without it, placing a pin would require a pixel-perfect press, and any
 * tremor of the hand - or of a trackpad - would pan the map instead.
 */
const TAP_THRESHOLD_PX = 4;

/** How far one arrow-key press moves the map, and how much less with Shift. */
const KEY_PAN_PX = 60;
const KEY_PAN_FINE_PX = 10;

/**
 * Size used for the square map until the viewport has been measured.
 *
 * The map is sized from the viewport's own pixel size, which is not known on the
 * first render. Rendering nothing until it arrives makes an empty frame, and an
 * empty frame is indistinguishable from a broken map - so the first frame gets a
 * plausible size and is corrected one tick later.
 */
const FALLBACK_SIDE_PX = 600;

/**
 * The work map.
 *
 * Pins are stored as percentages of the image box, never as pixels, so the same
 * row renders in the right place at any viewport, zoom level or device pixel
 * ratio. A pixel coordinate captured on a desktop would be meaningless on a
 * phone, and would also drift the moment the image is re-scaled by CSS.
 *
 * The map lives inside a fixed-height viewport and is panned by writing
 * `scrollLeft`/`scrollTop`, not by moving it with `transform` or by letting the
 * page scroll. That is the whole reason the right-hand part of a zoomed map was
 * unreachable: the scroll container had no height limit, so the box grew to
 * several screens tall and its horizontal scrollbar was drawn far below the fold,
 * out of reach of both the eye and the wheel.
 *
 * Using the scroll position rather than a transform has a second benefit: the
 * browser already clamps it, so there is no edge math to get wrong, no rubber-band
 * overshoot to fight, and wheel, shift+wheel, trackpad and arrow keys keep working
 * exactly as the platform defines them.
 *
 * Drag-to-pan is bound to mouse and pen only. A finger keeps native touch
 * scrolling, which is what a phone user expects and which needs no gesture
 * disambiguation.
 */
export function WorkMapTab({ profile }: { profile: ProfileDTO }) {
  const { data, error, pending, refresh } = useAsyncData<WorkPointRecord[]>(loadWorkPoints);
  const [scale, setScale] = useState(DEFAULT_SCALE);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftPin, setDraftPin] = useState<{ xPct: number; yPct: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
    distance: number;
  } | null>(null);

  // The viewport node is held in state, not in a ref.
  //
  // This tab renders a loading placeholder until the points arrive, so the viewport
  // div does not exist during the first passes. An earlier version read it from a
  // plain `useRef` inside a `[]` effect: on mount the ref was still `null`, the
  // effect returned early, and with no dependencies it never ran again - so the
  // map was never measured and stayed at zero size, an empty frame. A callback ref
  // is invoked by React when the node actually mounts, so the measurement cannot
  // miss it regardless of what the component rendered before.
  const [viewportEl, setViewportEl] = useState<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const isStaff = can(profile.role, "point.create");
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (selectedId || draftPin) {
      requestAnimationFrame(() => {
        detailRef.current?.scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
      });
    }
  }, [selectedId, draftPin]);

  // Track the viewport so the square map can be sized to fit inside it.
  //
  // The border box is measured, not `clientWidth`: `clientWidth` excludes the
  // scrollbar, so the scrollbar appearing above 100% would shrink the map, re-fire
  // this observer, and leave the map a couple of pixels smaller than it should be.
  // `getBoundingClientRect()` is unaffected by scrollbars, but it *does* include
  // the border, so the border is subtracted to recover the content box - otherwise
  // the map is 2px wider than the space available and a scrollbar shows at 100%.
  useEffect(() => {
    if (!viewportEl) return;

    const measure = () => {
      const rect = viewportEl.getBoundingClientRect();
      const style = getComputedStyle(viewportEl);
      const width =
        rect.width - parseFloat(style.borderLeftWidth) - parseFloat(style.borderRightWidth);
      const height =
        rect.height - parseFloat(style.borderTopWidth) - parseFloat(style.borderBottomWidth);

      setViewport((previous) =>
        // Same size, no re-render: this runs on every scrollbar and border change.
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(viewportEl);
    return () => observer.disconnect();
  }, [viewportEl]);

  const measuredSide = Math.min(viewport.width, viewport.height);
  const side = Math.round((measuredSide > 0 ? measuredSide : FALLBACK_SIDE_PX) * scale);

  const onPointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const element = event.currentTarget;

      // Left button only, and never a finger - see the file header.
      if (event.pointerType === "touch" || event.button !== 0) return;

      // A press that starts on a pin belongs to the pin, not to the pan.
      if ((event.target as HTMLElement).closest("[data-map-pin]")) return;

      // Without this the drag selects the pin labels and any stray text.
      event.preventDefault();
      element.setPointerCapture(event.pointerId);

      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        scrollLeft: element.scrollLeft,
        scrollTop: element.scrollTop,
        distance: 0,
      };
      setDragging(true);
    },
    [],
  );

  const onPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = event.currentTarget;
    if (!drag || drag.pointerId !== event.pointerId) return;

    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    drag.distance = Math.max(drag.distance, Math.hypot(dx, dy));

    // Offsets are taken from where the drag *started*, not from the previous frame,
    // so the map follows the pointer exactly and is clamped by the browser.
    element.scrollLeft = drag.scrollLeft - dx;
    element.scrollTop = drag.scrollTop - dy;
  }, []);

  /** Turn a completed press into a click or a no-op, depending on how far it moved. */
  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, allowPin: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      dragRef.current = null;
      setDragging(false);
      event.currentTarget.releasePointerCapture(event.pointerId);

      if (!allowPin || drag.distance > TAP_THRESHOLD_PX) return;

      const surface = surfaceRef.current;
      if (!surface) return;

      const rect = surface.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      setDraftPin({
        xPct: round2(clampPct((event.clientX - rect.left) / rect.width)),
        yPct: round2(clampPct((event.clientY - rect.top) / rect.height)),
      });
      setSelectedId(null);
    },
    [],
  );

  /** Arrow-key panning, so the map is not unreachable without a pointing device. */
  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const element = event.currentTarget;

    const step = event.shiftKey ? KEY_PAN_FINE_PX : KEY_PAN_PX;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [step, 0],
      ArrowRight: [-step, 0],
      ArrowUp: [0, step],
      ArrowDown: [0, -step],
    };

    const move = moves[event.key];
    if (!move) return;

    event.preventDefault();
    element.scrollLeft += move[0];
    element.scrollTop += move[1];
  }, []);

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

  const points = data ?? [];
  const selected = points.find((point) => point.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <PageTitle
        title="Карта работ"
        sub={
          isStaff
            ? "Перетащите карту мышью, чтобы двигать её. Клик по карте ставит точку."
            : "Перетаскивайте карту мышью. Нажмите на значок, чтобы открыть место."
        }
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setScale((value) => Math.max(MIN_SCALE, Number((value - 0.5).toFixed(1))))}
              disabled={scale <= MIN_SCALE}
              aria-label="Отдалить"
              className="rounded-lg border border-border p-2 text-muted-foreground transition hover:border-primary hover:text-cloud disabled:opacity-40"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="min-w-12 text-center text-xs text-muted-foreground">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setScale((value) => Math.min(MAX_SCALE, Number((value + 0.5).toFixed(1))))}
              disabled={scale >= MAX_SCALE}
              aria-label="Приблизить"
              className="rounded-lg border border-border p-2 text-muted-foreground transition hover:border-primary hover:text-cloud disabled:opacity-40"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>
        }
      />

      {/*
        The viewport. `tabIndex` and the focus ring are deliberate: the arrow keys
        are the only way to pan this without a mouse, and the ring is what tells a
        keyboard user the element took focus.
      */}
      <div
        ref={setViewportEl}
        role="application"
        aria-label="Карта работ. Стрелки - двигать карту."
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, isStaff)}
        onPointerCancel={(event) => endDrag(event, false)}
        onKeyDown={onKeyDown}
        className={`relative h-[55vh] overflow-auto overscroll-contain rounded-2xl border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:h-[68vh] ${
          dragging ? "cursor-grabbing" : isStaff ? "cursor-crosshair" : "cursor-grab"
        }`}
      >
        {/*
          The map is a square sized to fit the smaller viewport dimension, so at
          100% the whole map is visible and `margin: auto` centres it. Above 100%
          it exceeds the viewport on both axes and both scrollbars appear. A block
          box with `margin: auto` that is wider than its container resolves the
          margins to zero, which is exactly what makes the left and top edges
          reachable - the classic "centred flex item can never be scrolled to"
          trap does not apply here.
        */}
        <div
          className="relative mx-auto transition-[width,height] duration-200 select-none"
          style={{ width: side, height: side }}
        >
          <div ref={surfaceRef} className="relative h-full w-full">
            <Image
              src={mapImage}
              alt="Карта работ партии"
              width={mapImage.width}
              height={mapImage.height}
              unoptimized
              className="block h-full w-full"
              draggable={false}
            />

            {points.map((point) => (
              <button
                key={point.id}
                type="button"
                data-map-pin
                onClick={(event) => {
                  event.stopPropagation();
                  setSelectedId(point.id);
                  setDraftPin(null);
                }}
                style={{ left: `${point.xPct}%`, top: `${point.yPct}%` }}
                aria-label={point.title}
                className="absolute -translate-x-1/2 -translate-y-full"
              >
                <MapPin
                  className={`h-6 w-6 drop-shadow transition ${
                    point.status === "hidden" ? "text-muted-foreground" : "text-primary"
                  } ${selectedId === point.id ? "scale-125" : "hover:scale-110"}`}
                />
              </button>
            ))}

            {draftPin && (
              <span
                style={{ left: `${draftPin.xPct}%`, top: `${draftPin.yPct}%` }}
                className="pointer-events-none absolute h-6 w-6 -translate-x-1/2 -translate-y-full animate-pulse"
              >
                <MapPin className="h-6 w-6 text-destructive drop-shadow" />
              </span>
            )}
          </div>
        </div>
      </div>

      <div ref={detailRef} className="scroll-mt-6">
        {draftPin && (
          <PointForm
            point={{ xPct: draftPin.xPct, yPct: draftPin.yPct }}
            onDone={() => {
              setDraftPin(null);
              refresh();
            }}
            onCancel={() => setDraftPin(null)}
          />
        )}

        {selected && (
          <PointDetail
            point={selected}
            isStaff={isStaff}
            onClose={() => setSelectedId(null)}
            onChanged={refresh}
          />
        )}
      </div>

      {points.length === 0 && !draftPin && (
        <EmptyState
          title="Точек пока нет"
          hint={isStaff ? "Нажмите на карту, чтобы добавить первую." : undefined}
        />
      )}
    </div>
  );
}

const clampPct = (ratio: number) => Math.max(0, Math.min(100, ratio * 100));

const round2 = (value: number) => Math.round(value * 100) / 100;

/* -------------------------------------------------------------------------- */

function PointForm({
  point,
  onDone,
  onCancel,
}: {
  point: WorkPointRecord | { xPct: number; yPct: number };
  onDone: () => void;
  onCancel: () => void;
}) {
  // Resolved before the state initialisers below, which seed from it: editing an
  // existing point must open with its current title, description, image, kind and
  // status in the form, not blank fields that would overwrite the point on save.
  const existing = "id" in point ? point : null;

  const [title, setTitle] = useState(existing ? existing.title : "");
  const [description, setDescription] = useState(existing ? existing.description : "");
  const [imgurUrl, setImgurUrl] = useState(existing ? existing.imgurUrl : "");
  const [kind, setKind] = useState<WorkPointKind>(existing ? existing.kind : "work");
  const [status, setStatus] = useState<WorkPointStatus>(
    existing ? existing.status : "published",
  );
  const [saving, startTransition] = useTransition();

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveWorkPoint({
        id: existing?.id,
        title,
        description,
        imgurUrl,
        kind,
        status,
        xPct: point.xPct,
        yPct: point.yPct,
      });
      if (result.ok) {
        toast.success(existing ? "Точка обновлена" : "Точка добавлена");
        onDone();
      } else {
        toast.error(result.error);
      }
    });
  };

  return (
    <form onSubmit={submit}>
      <Panel className="space-y-3">
        <p className="text-xs text-muted-foreground">
          Координаты: {point.xPct.toFixed(1)}% по горизонтали, {point.yPct.toFixed(1)}% по вертикали
        </p>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Название"
          maxLength={50}
          className={fieldCls}
        />
        <input
          value={imgurUrl}
          onChange={(event) => setImgurUrl(event.target.value)}
          placeholder="Ссылка на фото с Imgur"
          className={fieldCls}
        />
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Что здесь делали, описание мероприятия"
          rows={3}
          maxLength={200}
          className={fieldCls}
        />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as WorkPointKind)}
            className={fieldCls}
          >
            {Object.entries(WORK_POINT_KIND_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as WorkPointStatus)}
            className={fieldCls}
          >
            {Object.entries(WORK_POINT_STATUS_LABELS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
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
            Сохранить
          </button>
        </div>
      </Panel>
    </form>
  );
}
function getDirectImgurUrl(url?: string | null): string | null {
  if (!url) return null;
  return url
    .trim()
    .replace(/^https?:\/\/(?:www\.)?imgur\.com\/a\/([a-zA-Z0-9]+)/, "https://i.imgur.com/$1.png")
    .replace(/^https?:\/\/i\.imgur\.com\/a\/([a-zA-Z0-9]+)(\.[a-zA-Z]+)?/, "https://i.imgur.com/$1$2");
}

function PointDetail({
  point,
  isStaff,
  onClose,
  onChanged,
}: {
  point: WorkPointRecord;
  isStaff: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, startTransition] = useTransition();

  const directImgUrl = getDirectImgurUrl(point.imgurUrl);

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

  if (editing) {
    return (
      <PointForm
        point={point}
        onDone={() => {
          setEditing(false);
          onClose();
          onChanged();
        }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  return (
    <Panel className="space-y-3">
      {/*
        The photo comes first, before the title, and it is the largest thing on
        screen: tapping a pin on a map is a request to see the place, and the
        picture answers it faster than any text can. A plain <img>, not
        next/image - the source is i.imgur.com, remote and unsized, so the
        optimiser would add a round trip and a revalidation path for nothing.
      */}
      {directImgUrl ? (
        <a
          href={directImgUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative block overflow-hidden rounded-xl border border-border"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={directImgUrl}
            alt={point.title}
            loading="lazy"
            referrerPolicy="no-referrer"
            className="max-h-[26rem] w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          />
          <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground opacity-0 backdrop-blur transition group-hover:opacity-100">
            <ExternalLink className="h-3 w-3" />
            Открыть оригинал
          </span>
        </a>
      ) : null}

      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium text-cloud">{point.title}</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {WORK_POINT_KIND_LABELS[point.kind]} · {point.createdByName}
          </p>
        </div>
        {point.status !== "published" && (
          <span className="shrink-0 rounded-full bg-muted-foreground/15 px-2.5 py-1 text-xs text-muted-foreground">
            {point.status === "hidden" ? "Скрыта" : "Черновик"}
          </span>
        )}
      </div>

      {point.description && (
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{point.description}</p>
      )}

      {isStaff && (
        <div className="mt-3 flex flex-wrap gap-2 border-t border-border pt-3">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud"
          >
            Изменить
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              run(
                () =>
                  saveWorkPoint({
                    id: point.id,
                    title: point.title,
                    description: point.description,
                    imgurUrl: point.imgurUrl,
                    kind: point.kind,
                    status: point.status === "hidden" ? "published" : "hidden",
                    xPct: point.xPct,
                    yPct: point.yPct,
                  }),
                point.status === "hidden" ? "Точка опубликована" : "Точка скрыта",
              )
            }
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud"
          >
            {point.status === "hidden" ? (
              <Eye className="h-3.5 w-3.5" />
            ) : (
              <EyeOff className="h-3.5 w-3.5" />
            )}
            {point.status === "hidden" ? "Показать" : "Скрыть"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => run(() => removeWorkPoint(point.id), "Точка удалена")}
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive hover:text-destructive"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Удалить
          </button>
        </div>
      )}

      {!isStaff && (
        <p className="mt-3 text-xs text-muted-foreground">
          Точки добавляют сотрудники партии. Если считаете, что место пропущено -
          напишите через раздел «Обращения».
        </p>
      )}
    </Panel>
  );
}
