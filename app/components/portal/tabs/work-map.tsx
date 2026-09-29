"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import {
  ChevronDown,
  ChevronUp,
  Eye,
  EyeOff,
  ExternalLink,
  Loader2,
  MapPin,
  Save,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { toast } from "sonner";

import { EmptyState, LoadingBlock, PageTitle, Panel, fieldCls } from "@/components/portal/primitives";
import { loadWorkPoints, removeWorkPoint, saveWorkPoint } from "@/lib/portal/actions";
import { useAsyncData } from "@/hooks/use-async-data";
import { cn } from "@/lib/utils";
import {
  WORK_POINT_KIND_LABELS,
  WORK_POINT_STATUS_LABELS,
  type WorkPointKind,
  type WorkPointRecord,
  type WorkPointStatus,
} from "@/lib/portal/types";
import type { ProfileDTO } from "@/types/auth";
import mapImage from "@/assets/map.png";
import { useCan } from "@/components/portal/permissions";

const MIN_SCALE = 1;
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
 * How much one wheel notch changes the scale.
 *
 * `exp` rather than a multiplication because a wheel reports deltas that are not
 * uniform - a Firefox line-scroll is 3 lines, a Windows notch is 120, a trackpad
 * fling is a stream of small deltas - and `exp` turns all of them into the same
 * "proportional to intent" curve. A fixed step per event would make a trackpad
 * fling unusable and a mouse notch almost imperceptible.
 */
const WHEEL_ZOOM_RATE = 0.0022;

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
 * The on-screen width and height of a pin, in CSS pixels.
 *
 * Fixed rather than derived, and paired with the `1 / scale` compensation on each
 * pin below: the two together are what make a pin the same size at every zoom
 * level. Sizing the pin as a percentage instead - the obvious move, since its
 * position is a percentage - would make it grow with the map, and at 500% a
 * nominal 24px pin would cover an eighth of the screen.
 */
const PIN_SIZE = 24;

/**
 * Size used for the square map until the viewport has been measured.
 *
 * The map is sized from the viewport's own pixel size, which is not known on the
 * first render. Rendering nothing until it arrives makes an empty frame, and an
 * empty frame is indistinguishable from a broken map - so the first frame gets a
 * plausible size and is corrected one tick later.
 */
const FALLBACK_SIDE_PX = 600;

/* -------------------------------------------------------------------------- */
/* The transform model                                                        */
/* -------------------------------------------------------------------------- */
/*
 * Everything on the map is positioned by ONE transform on ONE element:
 *
 *     transform: translate(tx, ty) scale(scale)
 *
 * with the origin at the top-left of a square `side x side` box, where `side` is
 * the smaller viewport dimension. The pins are children of that element and are
 * placed with `left: xPct%` / `top: yPct%`, so they are moved by the same matrix
 * as the image they sit on and cannot drift away from it. That is the whole reason
 * the pins are percentages of the image box and not pixels - see the note in
 * app/lib/portal/types.ts.
 *
 * THE THREE EQUATIONS
 *
 * image -> screen, for a point stored as a percentage:
 *
 *     screenX = tx + (pctX / 100) * side * scale
 *
 * screen -> image, which is what a click and a zoom anchor both need:
 *
 *     pctX = ((screenX - tx) / scale) / side * 100
 *
 * zoom about a fixed screen point, which is the interesting one. Let `ix` be the
 * image coordinate under the cursor, and the requirement is that it stays under
 * the cursor at the new scale. Substituting the first equation at both scales and
 * demanding the screen position be unchanged:
 *
 *     tx + ix*oldScale = tx' + ix*newScale   =>   tx' = tx + ix*(oldScale - newScale)
 *
 * which is what `zoomAbout` computes. Getting the sign of that term wrong is the
 * classic bug: the map zooms, but the ground under the cursor slides away from it
 * instead of staying put, and it is only obvious when you zoom in slowly.
 *
 * WHY NOT scrollLeft/scrollTop
 * The previous version panned by writing scroll offsets on a tall scroll
 * container. That works, and the browser's clamping is free - but it cannot express
 * "centre this point when the tab opens" without a second pass after the image has
 * laid out, and it has no notion of a transform to animate, so the zoom buttons
 * snapped while the wheel stepped. Clamping is a two-line function here, so the
 * browser's free clamping is not worth giving up the rest for.
 */

interface MapView {
  scale: number;
  tx: number;
  ty: number;
}

function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, value));
}

/**
 * Keep the map inside the frame.
 *
 * When the scaled map is larger than the viewport on an axis, it may be moved
 * anywhere between "flush against the far edge" and "flush against the near one",
 * and that is the range below. When it is *smaller* - only possible at the very
 * bottom of the zoom range - there is no range at all, and the map is centred
 * instead: an axis that is left at 0 would pin the map to a corner and read as a
 * mistake, which is the fallback the brief asks for on the opening frame.
 */
function clampOffset(value: number, viewportSize: number, contentSize: number): number {
  if (contentSize <= viewportSize) return (viewportSize - contentSize) / 2;
  return Math.min(0, Math.max(viewportSize - contentSize, value));
}

/** Clamp both axes of a view against the frame it has to stay inside. */
function settleView(
  view: MapView,
  side: number,
  width: number,
  height: number,
): MapView {
  const scaled = side * view.scale;

  return {
    scale: view.scale,
    tx: clampOffset(view.tx, width, scaled),
    ty: clampOffset(view.ty, height, scaled),
  };
}

const clampPct = (ratio: number) => Math.max(0, Math.min(100, ratio * 100));
const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * The point to open the map on: the most recently created one.
 *
 * "Most recent" by `createdAt`, not by position in the array, because the array
 * comes from the database with no `order by` guaranteeing anything - it is
 * whatever the query happened to return, and a new row can land anywhere in it.
 * A timestamp that does not parse falls back to the last element, which is the
 * closest thing to "the newest thing the server told us about".
 */
function newestPoint(points: readonly WorkPointRecord[]): WorkPointRecord | null {
  if (points.length === 0) return null;

  let best = points[points.length - 1];
  let bestTime = Date.parse(best.createdAt);

  for (const point of points) {
    const time = Date.parse(point.createdAt);
    if (Number.isNaN(time)) continue;
    if (Number.isNaN(bestTime) || time > bestTime) {
      best = point;
      bestTime = time;
    }
  }

  return best;
}

/**
 * Turn whatever is in the image field into something an `<img>` can load.
 *
 * The instruction under the field asks for a *direct* link from upload.ee, and a
 * direct link is the URL of the file - so it is used exactly as pasted. Nothing
 * here guesses at that host's path structure: inventing a transformation for it
 * would be a guess about a service this code has never seen, and a wrong guess
 * turns a valid link into a 404 that looks like the user's mistake.
 *
 * The Imgur rewrites are kept because the column predates the upload.ee
 * instruction and every stored point holds an Imgur share link, which is an album
 * page rather than an image. Left alone, those would render as a broken image on
 * the oldest and most likely to be looked-at points on the map.
 *
 * Returns null for anything that is not a usable http(s) URL, which is what the
 * form's live preview keys off.
 */
function resolveImageUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!value) return null;

  const album = value.match(/^https?:\/\/(?:www\.)?imgur\.com\/a\/([a-zA-Z0-9]+)/i);
  if (album) return `https://i.imgur.com/${album[1]}.png`;

  const single = value.match(/^https?:\/\/(?:www\.)?imgur\.com\/([a-zA-Z0-9]{5,})(?:\.[a-zA-Z]+)?/i);
  if (single) return `https://i.imgur.com/${single[1]}.jpg`;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  // `javascript:` and `data:` parse as URLs too. This string is rendered into an
  // `href` and an `img src`, so it is checked rather than trusted.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;

  return parsed.toString();
}

/* -------------------------------------------------------------------------- */

/**
 * The work map.
 *
 * Pins are stored as percentages of the image box, never as pixels, so the same
 * row renders in the right place at any viewport, zoom level or device pixel
 * ratio. A pixel coordinate captured on a desktop would be meaningless on a
 * phone, and would also drift the moment the image is re-scaled by CSS.
 *
 * The frame is `overflow-hidden` and the map is moved with a transform rather
 * than by scrolling the page or a tall inner container. The transform is one
 * matrix on one element, so the image and every pin on it are guaranteed to move
 * together - see the model note above the constants.
 *
 * The transition on the transform is what makes the wheel feel like a camera
 * rather than a stack of jumps, and it is removed while dragging so the map stays
 * welded to the pointer instead of trailing behind it.
 *
 * Drag-to-pan is bound to mouse and pen only. A finger keeps native touch
 * scrolling, which is what a phone user expects and which needs no gesture
 * disambiguation.
 */
export function WorkMapTab({ profile }: { profile: ProfileDTO }) {
  const { data, error, pending, refresh } = useAsyncData<WorkPointRecord[]>(loadWorkPoints);

  /**
   * The starting offset is the centred guess rather than zero, because the real
   * one is not computable until the viewport has been measured and the points have
   * loaded. Zero would put the top-left corner of a 3000px map in the top-left of
   * the frame - a blank corner of the district - for the frame or two before the
   * effect corrects it.
   */
  const [view, setView] = useState<MapView>(() => {
    const scaled = FALLBACK_SIDE_PX * DEFAULT_SCALE;
    return { scale: DEFAULT_SCALE, tx: -scaled / 2, ty: -scaled / 2 };
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draftPin, setDraftPin] = useState<{ xPct: number; yPct: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    tx: number;
    ty: number;
    distance: number;
  } | null>(null);

  /**
   * The frame's content-box origin in client coordinates, cached by the measuring
   * effect. The wheel handler needs it on every event, and reading
   * `getComputedStyle` per event to recover the border would force a style
   * recalculation per notch.
   */
  const originRef = useRef({ x: 0, y: 0 });

  /**
   * Whether the opening focus has been applied.
   *
   * A ref rather than state because it must not cause a render, and because it has
   * to survive the effect re-running on every resize: the map is positioned once,
   * when it is first able to be, and afterwards the viewer owns the camera.
   */
  const didFocusRef = useRef(false);

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

  // `point.create` is the self-service power: it lets a holder add markers, and
  // keep the ones they added. `point.editAny`/`point.deleteAny` are the map
  // maintainer's power over everybody else's markers. The map has always treated
  // these as one flag; with database roles they are three, and collapsing them
  // would make "add my own point" and "rewrite the party map" the same job.
  const mayCreate = useCan("point.create");
  const mayEditAny = useCan("point.editAny");
  const mayDeleteAny = useCan("point.deleteAny");

  const formRef = useRef<HTMLDivElement>(null);

  // Memoised rather than written as `data ?? []`: an inline fallback builds a new
  // array identity on every render, which would re-derive `selected` and re-render
  // every pin on every measurement tick from the ResizeObserver.
  const points = useMemo(() => data ?? [], [data]);
  const selected = useMemo(
    () => points.find((point) => point.id === selectedId) ?? null,
    [points, selectedId],
  );

  /**
   * Measure the frame, and on the first measurement point the camera.
   *
   * Both live together because both need the same number: centring a point requires
   * knowing the frame's size, which is not knowable until the DOM has laid out.
   *
   * The border box is measured, not `clientWidth`: `clientWidth` excludes the
   * scrollbar, so the scrollbar appearing above 100% would shrink the map, re-fire
   * this observer, and leave the map a couple of pixels smaller than it should be.
   * `getBoundingClientRect()` is unaffected by scrollbars, but it *does* include
   * the border, so the border is subtracted to recover the content box - otherwise
   * the map is 2px wider than the space available.
   */
  useEffect(() => {
    if (!viewportEl) return;

    const apply = (width: number, height: number) => {
      setViewport((previous) =>
        // Same size, no re-render: this runs on every scrollbar and border change.
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );

      // Past the first measurement the viewer owns the camera - their pan, their
      // zoom, their place on the map - and a later resize or a refresh must not
      // take it away from them.
      if (didFocusRef.current) return;

      const mapSide = Math.min(width, height);
      if (mapSide <= 0) return;
      didFocusRef.current = true;

      // The most recent point, or 50/50 - the centre of the image box - when there
      // is nothing to centre on, which frames the whole district rather than one
      // corner of it.
      const focus = newestPoint(points);
      const imageX = ((focus ? focus.xPct : 50) / 100) * mapSide;
      const imageY = ((focus ? focus.yPct : 50) / 100) * mapSide;

      setView((previous) =>
        settleView(
          {
            scale: previous.scale,
            tx: width / 2 - imageX * previous.scale,
            ty: height / 2 - imageY * previous.scale,
          },
          mapSide,
          width,
          height,
        ),
      );
    };

    const measure = () => {
      const rect = viewportEl.getBoundingClientRect();
      const style = getComputedStyle(viewportEl);
      const borderLeft = parseFloat(style.borderLeftWidth) || 0;
      const borderTop = parseFloat(style.borderTopWidth) || 0;

      // Everything the wheel handler measures is relative to this point, so it is
      // cached here rather than recomputed per event.
      originRef.current = { x: rect.left + borderLeft, y: rect.top + borderTop };

      apply(
        rect.width - borderLeft - (parseFloat(style.borderRightWidth) || 0),
        rect.height - borderTop - (parseFloat(style.borderBottomWidth) || 0),
      );
    };

    // Once immediately, so the map is never painted at the fallback size. The
    // observer then keeps it correct across resizes.
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(viewportEl);
    return () => observer.disconnect();
  }, [viewportEl, points]);

  const measuredSide = Math.min(viewport.width, viewport.height);
  const side = Math.round(measuredSide > 0 ? measuredSide : FALLBACK_SIDE_PX);

  /**
   * Wheel zoom, anchored on the cursor.
   *
   * A native listener rather than React's `onWheel`, because React attaches wheel
   * handlers passively and this one has to call `preventDefault`: the frame no
   * longer scrolls, so without it every notch would scroll the *page* out from
   * under the map as well as zooming it.
   */
  useEffect(() => {
    const element = viewportEl;
    if (!element) return;

    const onWheel = (event: WheelEvent) => {
      const surface = surfaceRef.current;
      if (!surface) return;

      /**
       * The wheel is over the panel or its scrim, so it belongs to them.
       *
       * A React `onWheel` with `stopPropagation` cannot express this: React
       * attaches its listeners at the root, which is an *ancestor* of this
       * element, so this native listener has already run by the time a synthetic
       * handler on a child gets its turn. The test has to be made here, against
       * the event's real target. Returning without `preventDefault` is what lets
       * the description inside the panel scroll normally.
       */
      if ((event.target as HTMLElement | null)?.closest("[data-map-overlay]")) return;

      event.preventDefault();

      const surfaceRect = surface.getBoundingClientRect();

      // The scale and offset the map is *actually drawn* at, measured rather than
      // read from state. The transform is animated, so the state is the target and
      // the map on screen is still travelling towards it; anchoring to the target
      // would make the ground under the cursor drift for the length of the
      // transition, which is exactly the wobble that makes naive wheel zoom feel
      // broken.
      const liveScale = surfaceRect.width / surface.offsetWidth;
      if (!Number.isFinite(liveScale) || liveScale <= 0) return;

      const origin = originRef.current;
      const cursorX = event.clientX - origin.x;
      const cursorY = event.clientY - origin.y;
      const liveTx = surfaceRect.left - origin.x;
      const liveTy = surfaceRect.top - origin.y;

      const step = Math.exp(-event.deltaY * WHEEL_ZOOM_RATE);

      setView((previous) => {
        const next = clampScale(previous.scale * step);
        if (next === previous.scale) return previous;

        // Image coordinate under the cursor, from the live transform...
        const imageX = (cursorX - liveTx) / liveScale;
        const imageY = (cursorY - liveTy) / liveScale;

        // ...and the offset that puts it back under the same cursor at the new
        // scale. See the derivation in the model note.
        return settleView(
          {
            scale: next,
            tx: cursorX - imageX * next,
            ty: cursorY - imageY * next,
          },
          side,
          viewport.width,
          viewport.height,
        );
      });
    };

    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [viewportEl, side, viewport.width, viewport.height]);

  /** The + and - buttons: the same anchor maths, about the middle of the frame. */
  const zoomAboutCentre = useCallback(
    (factor: number) => {
      setView((previous) => {
        const next = clampScale(previous.scale * factor);
        if (next === previous.scale) return previous;

        const centreX = viewport.width / 2;
        const centreY = viewport.height / 2;
        const imageX = (centreX - previous.tx) / previous.scale;
        const imageY = (centreY - previous.ty) / previous.scale;

        return settleView(
          { scale: next, tx: centreX - imageX * next, ty: centreY - imageY * next },
          side,
          viewport.width,
          viewport.height,
        );
      });
    },
    [side, viewport.width, viewport.height],
  );

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const element = event.currentTarget;

    // Left button only, and never a finger - see the file header.
    if (event.pointerType === "touch" || event.button !== 0) return;

    /**
     * A press that starts on a pin belongs to the pin, not to the pan.
     *
     * Returning *before* the capture is what keeps the click intact. Capturing the
     * pointer would retarget the subsequent `click` to the frame, so opening a
     * point would stop working the moment a drag was introduced - and the symptom
     * (pins that sometimes open and sometimes pan the map) is very hard to read as
     * a capture problem.
     */
    if ((event.target as HTMLElement).closest("[data-map-pin]")) return;

    // Without this the drag selects the pin labels and any stray text.
    event.preventDefault();
    element.setPointerCapture(event.pointerId);

    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      tx: view.tx,
      ty: view.ty,
      distance: 0,
    };
    setDragging(true);
  }, [view.tx, view.ty]);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      drag.distance = Math.max(drag.distance, Math.hypot(dx, dy));

      // Offsets are taken from where the drag *started*, not from the previous
      // frame, so the map follows the pointer exactly and cannot drift.
      setView((previous) =>
        settleView(
          { ...previous, tx: drag.tx + dx, ty: drag.ty + dy },
          side,
          viewport.width,
          viewport.height,
        ),
      );
    },
    [side, viewport.width, viewport.height],
  );

  /** Turn a completed press into a click or a no-op, depending on how far it moved. */
  const endDrag = useCallback(
    (event: React.PointerEvent<HTMLDivElement>, allowPin: boolean) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;

      dragRef.current = null;
      setDragging(false);

      // The browser drops the capture on its own when a pointer is cancelled or
      // leaves the window, so releasing one that is no longer held would throw.
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }

      if (!allowPin || drag.distance > TAP_THRESHOLD_PX) return;

      const surface = surfaceRef.current;
      if (!surface) return;

      /**
       * The click, in stored form.
       *
       * `getBoundingClientRect()` returns the *transformed* box, so the ratio of
       * the cursor's offset from the surface's left edge to the surface's rendered
       * width is the percentage of the image - at any scale, with any offset,
       * mid-animation. Dividing by the transformed width rather than by the
       * untransformed `side` is what makes the zoom level and the pan drop out of
       * the calculation entirely instead of having to be un-applied by hand.
       */
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
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
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
      setView((previous) =>
        settleView(
          { ...previous, tx: previous.tx + move[0], ty: previous.ty + move[1] },
          side,
          viewport.width,
          viewport.height,
        ),
      );
    },
    [side, viewport.width, viewport.height],
  );

  /**
   * Open a point in the panel.
   *
   * A draft in progress is dropped: the panel and the form are two different
   * answers to "what now", and leaving a half-filled form on the page under an
   * unrelated point is how a coordinate gets saved to the wrong place.
   */
  const openPoint = useCallback((point: WorkPointRecord) => {
    setSelectedId(point.id);
    setDraftPin(null);
  }, []);

  const closePanel = useCallback(() => setSelectedId(null), []);

  // A new point is placed below the map, so the page moves to it. Smooth, because
  // the alternative is the form appearing instantly at the bottom of the viewport
  // with no indication of how it got there.
  useEffect(() => {
    if (!draftPin) return;

    const frame = requestAnimationFrame(() => {
      formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    return () => cancelAnimationFrame(frame);
  }, [draftPin]);

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
      <PageTitle
        title="Карта работ"
        sub={
          mayCreate
            ? "Клик по карте ставит точку. Колесо мыши - зум, перетаскивание - сдвиг."
            : "Колесо мыши - зум, перетаскивание - сдвиг. Нажмите на значок, чтобы открыть место."
        }
        action={
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => zoomAboutCentre(1 / 1.5)}
              disabled={view.scale <= MIN_SCALE}
              aria-label="Отдалить"
              className="rounded-lg border border-border p-2 text-muted-foreground transition hover:border-primary hover:text-cloud disabled:opacity-40"
            >
              <ZoomOut className="h-4 w-4" />
            </button>
            <span className="min-w-12 text-center text-xs text-muted-foreground">
              {Math.round(view.scale * 100)}%
            </span>
            <button
              type="button"
              onClick={() => zoomAboutCentre(1.5)}
              disabled={view.scale >= MAX_SCALE}
              aria-label="Приблизить"
              className="rounded-lg border border-border p-2 text-muted-foreground transition hover:border-primary hover:text-cloud disabled:opacity-40"
            >
              <ZoomIn className="h-4 w-4" />
            </button>
          </div>
        }
      />

      {/*
        The frame. `tabIndex` and the focus ring are deliberate: the arrow keys are
        the only way to pan this without a mouse, and the ring is what tells a
        keyboard user the element took focus.

        `touch-action: none` is not set: a finger is meant to scroll the page, so
        the browser's own panning is left alone. The wheel listener is the only
        thing here that suppresses a native gesture, and only because this frame
        does not scroll itself.
      */}
      <div
        ref={setViewportEl}
        role="application"
        aria-label="Карта работ. Колесо мыши - зум, стрелки - двигать карту."
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(event) => endDrag(event, mayCreate)}
        onPointerCancel={(event) => endDrag(event, false)}
        onKeyDown={onKeyDown}
        className={`relative h-[55vh] touch-pan-y overflow-hidden overscroll-contain rounded-2xl border border-border bg-background outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:h-[68vh] ${
          dragging ? "cursor-grabbing" : mayCreate ? "cursor-crosshair" : "cursor-grab"
        }`}
      >
        {/*
          The map. Positioned at the origin and moved entirely by one transform, so
          the image and its pins are scaled and shifted by the same matrix and stay
          locked together by construction.

          The transition is what makes the wheel read as a camera. It is dropped
          while dragging so the map tracks the pointer instead of easing towards it,
          and dropped for the duration of a press for the same reason.
        */}
        <div
          ref={surfaceRef}
          className={`absolute left-0 top-0 origin-top-left will-change-transform ${
            dragging ? "" : "transition-transform duration-200 ease-out"
          }`}
          style={{
            width: side,
            height: side,
            transform: `translate3d(${view.tx}px, ${view.ty}px, 0) scale(${view.scale})`,
          }}
        >
          <Image
            src={mapImage}
            alt="Карта работ партии"
            width={mapImage.width}
            height={mapImage.height}
            unoptimized
            className="block h-full w-full select-none"
            draggable={false}
          />

          {/*
            The pins.

            They are children of the scaled surface, so without help they would
            grow with the map: at the 500% the tab opens at, a 24px pin is drawn
            120px across. Each one therefore carries `scale(1 / currentScale)` to
            cancel its parent's zoom, and is sized in fixed pixels, so a pin is
            24px on screen at every zoom level.

            The transform is written out in full rather than using Tailwind's
            `-translate-x-1/2 -translate-y-full`. In Tailwind v4 those compile to
            the separate `translate` property, which is applied *before* `transform`
            in the transform chain - so an inline `transform` for the inverse scale
            would compose with them rather than replace them, and the pin would end
            up offset by its own dimensions.

            `transform-origin: 50% 100%` - bottom centre - is what makes the maths
            work: scaling about the tip leaves the tip where it is, and the
            following translate then moves that tip onto the stored coordinates. So
            the point a pin marks is its own tip, at any zoom, and the icon does not
            drift off the spot as the map zooms.
          */}
          {points.map((point) => (
            <button
              key={point.id}
              type="button"
              data-map-pin
              onClick={(event) => {
                // The pin is inside the drag target, so without this a press that
                // ends without moving would also fall through to the map and place
                // a second point on top of the one being opened.
                event.stopPropagation();
                openPoint(point);
              }}
              style={{
                left: `${point.xPct}%`,
                top: `${point.yPct}%`,
                width: PIN_SIZE,
                height: PIN_SIZE,
                transform: `translate(-50%, -100%) scale(${1 / view.scale})`,
                transformOrigin: "50% 100%",
              }}
              aria-label={point.title}
              aria-expanded={selectedId === point.id}
              className="absolute grid place-items-center"
            >
              <MapPin
                className={cn(
                  "h-full w-full drop-shadow transition-colors",
                  point.status === "hidden" ? "text-muted-foreground" : "text-primary",
                )}
                strokeWidth={2.25}
              />
              {selectedId === point.id ? (
                <span className="absolute inset-0 -z-10 rounded-full bg-primary/25" />
              ) : null}
            </button>
          ))}

          {draftPin && (
            <span
              style={{
                left: `${draftPin.xPct}%`,
                top: `${draftPin.yPct}%`,
                width: PIN_SIZE,
                height: PIN_SIZE,
                transform: `translate(-50%, -100%) scale(${1 / view.scale})`,
                transformOrigin: "50% 100%",
              }}
              className="pointer-events-none absolute"
            >
              <MapPin className="h-full w-full animate-pulse text-destructive drop-shadow" />
            </span>
          )}
        </div>

        {/*
          The detail panel, INSIDE the frame.

          The obvious way to build this - a dialog primitive, portalled to the body
          and positioned `fixed inset-y-0` - is wrong here for a reason specific to
          this component: the map is a bounded box in the middle of a scrolling
          page, so a full-viewport-height panel would cover the site header, the
          navigation and the rest of the portal, making a map detail look like it
          had taken over the screen. Being absolute inside the frame's
          `overflow-hidden` means it is dimensioned by the map, clipped by it, and
          scrolls with it.

          `w-80 max-w-full sm:max-w-[40%]` - a comfortable fixed width, capped at
          40% so the map stays visible beside it. `max-w-full` rather than a flat
          40% because on a phone the frame itself is only ~350px wide, and 40% of
          that is ~140px: a title clamped to two lines across four characters.

          The slide is `translate-x` only. Animating the width would re-wrap the
          text on every frame; a transform slides the finished layout sideways.

          Stays mounted when closed so the exit animation can run, and
          `pointer-events-none` while off-frame so it cannot swallow a click aimed
          at the map underneath.
        */}
        <div
          data-map-overlay
          className={cn(
            "absolute inset-y-0 right-0 z-20 w-80 max-w-full overflow-y-auto overscroll-contain",
            "border-l border-border bg-background shadow-2xl",
            "transition-transform duration-300 ease-out motion-reduce:transition-none",
            selected ? "translate-x-0" : "pointer-events-none translate-x-full",
          )}
          onPointerDown={(event) => event.stopPropagation()}
          onWheel={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            // Arrow keys pan the map. Letting them through while the focus is in
            // here would scroll the panel and move the camera at the same time.
            // Escape is the exception - it is the keyboard equivalent of the scrim,
            // and the panel is not modal, so nothing else would handle it.
            if (event.key === "Escape") {
              event.stopPropagation();
              closePanel();
              return;
            }
            event.stopPropagation();
          }}
          role="dialog"
          aria-label={selected ? `Точка: ${selected.title}` : "Точка"}
          aria-hidden={!selected}
        >
          {selected ? (
            <PointDetail
              point={selected}
              mayCreate={mayCreate}
              mayEditAny={mayEditAny}
              mayDeleteAny={mayDeleteAny}
              viewerSteamId={profile.steamId}
              onClose={closePanel}
              onChanged={refresh}
            />
          ) : null}
        </div>

        {/*
          The scrim, also inside the frame, and under the panel (`z-10` vs `z-20`).
          It dims the map so the panel has something to sit against, and clicking it
          closes - so the map is never fully blocked with no way back out.
        */}
        {selected ? (
          <button
            type="button"
            data-map-overlay
            aria-label="Закрыть панель"
            onClick={closePanel}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
            className="absolute inset-0 z-10 cursor-default bg-black/50 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:duration-200"
          />
        ) : null}
      </div>

      {/*
        The form lives below the map and the page scrolls to it, rather than the map
        growing a panel: a draft point's coordinates are meaningless without the
        image next to them, and the form is the thing being asked for.
      */}
      {draftPin && (
        <div ref={formRef} className="scroll-mt-6 animate-in fade-in-0 slide-in-from-bottom-2 duration-300">
          <PointForm
            point={{ xPct: draftPin.xPct, yPct: draftPin.yPct }}
            onDone={() => {
              setDraftPin(null);
              refresh();
            }}
            onCancel={() => setDraftPin(null)}
          />
        </div>
      )}

      {points.length === 0 && !draftPin && (
        <EmptyState
          title="Точек пока нет"
          hint={mayCreate ? "Нажмите на карту, чтобы добавить первую." : undefined}
        />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const UPLOAD_HOST = "https://upload.ee";

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
  const [imageUrl, setImageUrl] = useState(existing ? existing.imgurUrl : "");
  const [kind, setKind] = useState<WorkPointKind>(existing ? existing.kind : "work");
  const [status, setStatus] = useState<WorkPointStatus>(
    existing ? existing.status : "published",
  );
  const [saving, startTransition] = useTransition();

  // Live, so the preview appears as the link is pasted rather than on save. Three
  // states, not two: "empty" and "this is not a link" are different problems and
  // the field says so.
  const typed = imageUrl.trim();
  const previewUrl = resolveImageUrl(imageUrl);
  const urlState: "empty" | "invalid" | "ok" = typed === "" ? "empty" : previewUrl ? "ok" : "invalid";

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    startTransition(async () => {
      const result = await saveWorkPoint({
        id: existing?.id,
        title,
        description,
        // The column is still called `imgurUrl` and is still what the server
        // writes; what changed is what goes in it.
        imgurUrl: imageUrl,
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

        <div>
          <input
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            placeholder="Прямая ссылка на фото"
            inputMode="url"
            className={fieldCls}
          />

          {/*
            The instruction sits directly under the field it is about, and the host
            is a real link rather than the bare hostname: the whole difficulty of
            this field is that the thing people paste is a page URL, not an image
            URL, and the fix is one click away.
          */}
          <p className="mt-1.5 text-xs text-muted-foreground">
            Загрузите фото на{" "}
            <a
              href={UPLOAD_HOST}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline-offset-2 hover:underline"
            >
              upload.ee
            </a>{" "}
            и вставьте прямую ссылку сюда
          </p>

          {urlState === "ok" && previewUrl ? (
            <a
              href={previewUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group relative mt-2 block overflow-hidden rounded-xl border border-border"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewUrl}
                alt="Предпросмотр загруженного фото"
                referrerPolicy="no-referrer"
                className="max-h-56 w-full object-cover transition duration-300 group-hover:scale-[1.02]"
              />
              <span className="pointer-events-none absolute right-2 top-2 flex items-center gap-1.5 rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground opacity-0 backdrop-blur transition group-hover:opacity-100">
                <ExternalLink className="h-3 w-3" />
                Открыть оригинал
              </span>
            </a>
          ) : null}

          {urlState === "invalid" ? (
            <p className="mt-1.5 text-xs text-destructive">
              Это не похоже на ссылку. Нужен адрес файла, начинающийся с http:// или https://
            </p>
          ) : null}
        </div>

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

/**
 * The panel's close control.
 *
 * Supplied here rather than taken from a dialog primitive, because the panel is
 * deliberately not one: it is a bounded region inside the map frame, not a modal
 * over the page, so it neither portals out nor brings its own overlay and close
 * button. Two ways out - this and the scrim behind it - is what a non-modal panel
 * needs; a third (Escape) is wired on the container.
 */
function PanelClose({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Закрыть"
      className="absolute right-2 top-2 z-10 rounded-full bg-background/85 p-1.5 text-muted-foreground backdrop-blur transition hover:bg-background hover:text-cloud focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
    >
      <X className="h-4 w-4" />
    </button>
  );
}

/**
 * The panel body: one point in full.
 *
 * Lives inside the map's panel rather than under the map, so opening a pin covers
 * the map with the answer instead of pushing it below the fold - and so closing it
 * puts the viewer back on the pin they were looking at, at the zoom and offset
 * they had chosen.
 *
 * Rendered inside the map's panel, which is sized by the map rather than the page.
 * That is what makes the overflow rules below necessary rather than decorative: a
 * fixed-width column of user-supplied text inside a 320px box will overflow if
 * given the chance, and the failure mode is the panel growing past the frame it is
 * meant to be clipped by.
 */
function PointDetail({
  point,
  mayCreate,
  mayEditAny,
  mayDeleteAny,
  viewerSteamId,
  onClose,
  onChanged,
}: {
  point: WorkPointRecord;
  mayCreate: boolean;
  mayEditAny: boolean;
  mayDeleteAny: boolean;
  viewerSteamId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, startTransition] = useTransition();

  /**
   * Collapse the description again whenever a different point is shown.
   *
   * The panel is reused for every point, so without this the toggle state carries
   * across: open a long description, close, open a short one, and it is already
   * expanded - or the reverse, a long one opens truncated with the reader
   * expecting it to be complete. Keyed on the id rather than run in an effect so
   * React discards the stale render itself.
   */
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const descriptionOpenNow = expandedFor === point.id;

  // Same pairing the DAL evaluates: a marker may be changed by whoever made it,
  // on the strength of `point.create`, or by anybody holding the `Any` variant.
  const isAuthor = point.createdBy === viewerSteamId;
  const canEdit = mayEditAny || (isAuthor && mayCreate);
  const canDelete = mayDeleteAny || (isAuthor && mayCreate);

  const imageUrl = resolveImageUrl(point.imgurUrl);

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

  // Editing replaces the body in place rather than opening a second surface. The
  // panel is already the focused context, and a form in a dialog inside a dialog
  // is a lot of nesting for three text fields.
  if (editing) {
    return (
      // `relative` anchors the close button, and the extra top padding keeps it
      // clear of the first field instead of sitting on top of it.
      <div className="relative p-6 pt-12">
        <PanelClose onClick={onClose} />
        <PointForm
          point={point}
          onDone={() => {
            setEditing(false);
            onClose();
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="relative flex min-h-full flex-col">
      <PanelClose onClick={onClose} />
      {/*
        The photo comes first, before the title, and it is the largest thing in the
        panel: tapping a pin on a map is a request to see the place, and the picture
        answers it faster than any text can. A plain <img>, not next/image - the
        source is remote and unsized, so the optimiser would add a round trip and a
        revalidation path for nothing.
      */}
      {imageUrl ? (
        <a
          href={imageUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="group relative block shrink-0 overflow-hidden bg-card"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imageUrl}
            alt={point.title}
            referrerPolicy="no-referrer"
            // A percentage of the panel rather than a fixed rem height: the panel is
            // the height of the map, which is a viewport fraction, so a fixed height
            // would be right on a tall screen and swallow the entire panel - title,
            // description and all - on a short one.
            className="max-h-[45%] w-full object-cover transition duration-300 group-hover:scale-[1.02]"
          />
          <span className="pointer-events-none absolute right-3 top-3 flex items-center gap-1.5 rounded-full bg-background/85 px-2.5 py-1 text-[11px] text-muted-foreground opacity-0 backdrop-blur transition group-hover:opacity-100">
            <ExternalLink className="h-3 w-3" />
            Открыть оригинал
          </span>
        </a>
      ) : null}

      <div className="flex-1 space-y-3 p-6">
        {/*
          The title.

          `line-clamp-2` rather than `truncate`, because a map point's name is its
          identity - "Двор №14" losing its tail to an ellipsis is worse than the
          second line being allowed. `break-words` is the other half: a pasted
          coordinate run or a URL has no spaces, and without it the longest
          unbroken token sets the panel's minimum width and pushes the panel itself
          out past its own edge.
        */}
        <h2 className="line-clamp-2 break-words font-display text-xl leading-tight text-cloud">
          {point.title}
        </h2>
        <p className="break-words text-xs text-muted-foreground">
          {WORK_POINT_KIND_LABELS[point.kind]} · {point.createdByName} ·{" "}
          {new Date(point.createdAt).toLocaleDateString("ru-RU")}
        </p>

        {point.status !== "published" && (
          <span className="inline-block rounded-full bg-muted-foreground/15 px-2.5 py-1 text-xs text-muted-foreground">
            {WORK_POINT_STATUS_LABELS[point.status]}
          </span>
        )}

        {/*
          The description.

          Collapsed to three lines with a toggle, and scrollable when expanded. Both
          halves are needed: descriptions here run to several paragraphs of
          meeting minutes, so an always-expanded block pushes the actions off the
          bottom of a panel whose height is the map's, while an always-collapsed one
          hides the part someone opened the point to read.

          `whitespace-pre-wrap` keeps the line breaks the author typed, and
          `break-words` + `overflow-wrap: anywhere` stop a long token - a bare URL,
          a run of digits - from forcing the whole panel wider than the frame.
        */}
        {point.description ? (
          <div className="space-y-1">
            <p
              className={cn(
                "whitespace-pre-wrap break-words text-sm leading-relaxed text-muted-foreground [overflow-wrap:anywhere]",
                descriptionOpenNow ? "max-h-48 overflow-y-auto" : "line-clamp-3",
              )}
            >
              {point.description}
            </p>
            {/*
              A character count rather than a measurement: reading the real height
              needs a layout pass and a resize observer for a button that is usually
              obvious either way. The threshold is set high enough that a short
              description never shows a toggle that does nothing.
            */}
            {point.description.length > 140 ? (
              <button
                type="button"
                onClick={() => setExpandedFor(descriptionOpenNow ? null : point.id)}
                className="inline-flex items-center gap-1 text-xs font-medium text-primary transition hover:underline"
              >
                {descriptionOpenNow ? (
                  <>
                    Свернуть
                    <ChevronUp className="h-3.5 w-3.5" />
                  </>
                ) : (
                  <>
                    Читать далее
                    <ChevronDown className="h-3.5 w-3.5" />
                  </>
                )}
              </button>
            ) : null}
          </div>
        ) : (
          <p className="break-words text-sm text-muted-foreground">Описание не заполнено.</p>
        )}

        <p className="text-xs text-muted-foreground">
          {point.xPct.toFixed(1)}% по горизонтали, {point.yPct.toFixed(1)}% по вертикали
        </p>

        {(canEdit || canDelete) && (
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            {canEdit && (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-primary hover:text-cloud"
              >
                Изменить
              </button>
            )}
            {canEdit && (
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
            )}
            {canDelete && (
              <button
                type="button"
                disabled={busy}
                onClick={() => run(() => removeWorkPoint(point.id), "Точка удалена")}
                className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs text-muted-foreground transition hover:border-destructive hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Удалить
              </button>
            )}
          </div>
        )}

        {!mayCreate && (
          <p className="text-xs text-muted-foreground">
            Точки добавляют сотрудники партии. Если считаете, что место пропущено -
            напишите через раздел «Обращения».
          </p>
        )}
      </div>
    </div>
  );
}
