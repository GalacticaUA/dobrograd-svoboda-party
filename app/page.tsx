import Image from "next/image";
import { CalendarDays, Clock, MapPin, User } from "lucide-react";
import heroBackground from "@/assets/background.jpg";
import { CountUp } from "@/components/ui/count-up";
import { ParticleField } from "@/components/ui/particle-field";
import { Reveal } from "@/components/ui/reveal";
import { SectionHeading } from "@/components/ui/section-heading";
import { ShinyLink } from "@/components/ui/shiny-button";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { Timeline } from "@/components/modules/cms/timeline";
import { mockCms } from "@/data/mockData";
import {
  chronicle,
  feed,
  feedKindLabel,
  leaders,
  manifesto,
  milestones,
  pillars,
} from "@/data/content";
import { listPublicEvents } from "@/lib/portal/dal";
import type { EventState, PublicEvent } from "@/lib/portal/types";
import {
  formatEventDay,
  formatEventTimeRange,
  formatEventWeekday,
} from "@/lib/dates";

import { getSupabaseAdmin } from "@/lib/supabase/server";

/**
 * How each time-derived state reads on the public page.
 *
 * The wording is the whole point of splitting the list. A past meeting under a
 * heading that says "come to our meetings" is a small lie, and it is one an
 * outsider notices - they click through, find a date in the past, and conclude the
 * party is dead. So the archive is labelled as an archive and pushed below the fold.
 */
const PUBLIC_STATE_LABELS: Record<EventState, string> = {
  draft: "Черновик",
  upcoming: "Будет",
  live: "Идёт прямо сейчас",
  past: "Прошло",
};

const PUBLIC_STATE_CLASSES: Record<EventState, string> = {
  draft: "border-amber-500/40 text-amber-400",
  upcoming: "border-primary/40 text-primary",
  live: "border-emerald-500/40 text-emerald-400",
  past: "border-border text-muted-foreground",
};

/**
 * The homepage.
 *
 * Async because the event list is read from the database. It is a server
 * component for that reason, and it is also the right place for the read in
 * general: an anonymous visitor gets the events in the HTML of the first response
 * with no extra round trip, and the service-role key never comes near the
 * browser. Nothing here asks for a session - this page is what a stranger sees.
 *
 * If Supabase is not configured yet, `listPublicEvents` throws and the section
 * below falls back to nothing rather than taking the whole page down.
 *
 * `/` is not prerendered - no `page.html` lands in the build output and the
 * prerender manifest lists only `/_global-error` and `/favicon.ico` - so the state
 * of every event is recomputed per request. A statically generated page would have
 * frozen "Будет" onto last month's meeting until the next deploy.
 */
export default async function HomePage() {
  const supabase = getSupabaseAdmin();

  const [upcoming, past, approvedMembersCount] = await Promise.all([
    listPublicEvents("upcoming", 4).catch(() => []),
    listPublicEvents("past", 3).catch(() => []),
    (async () => {
      const { count, error } = await supabase
        .from("profiles")
        .select("*", { count: "exact", head: true })
        .eq("status", "approved");

      if (error) {
        console.error("[HomePage] Ошибка подсчёта профилей:", error);
        return 0;
      }

      return count ?? 0;
    })().catch(() => 0),
  ]);

  const dynamicMilestones = milestones.map((m, index) => {
    if (index === 0) {
      return {
        ...m,
        value: approvedMembersCount,
        suffix: "",
      };
    }
    return m;
  });
  return (
    <>
      {/* Hero */}
      <section className="relative isolate overflow-hidden">
        <Image
          src={heroBackground}
          alt=""
          fill
          priority
          sizes="100vw"
          className="-z-20 object-cover object-center"
        />
        <div className="absolute inset-0 -z-10 bg-gradient-to-b from-background/90 via-background/75 to-background" />
        <div className="grid-fade absolute inset-0 -z-10" />
        <ParticleField count={45} />

        <div className="relative z-10 mx-auto flex max-w-5xl flex-col items-center gap-8 px-5 py-28 text-center sm:py-36">
          <Reveal immediate>
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
              {/* {SITE_NAME} | Доброград */}
              ЛИБЕРАЛЬНО-ДЕМОКРАТИЧЕСКАЯ ПАРТИЯ
            </p>
          </Reveal>

          <Reveal immediate delay={0.05}>
            <h1 className="font-display text-4xl font-bold leading-[1.05] tracking-tight text-cloud sm:text-6xl lg:text-7xl">
              {mockCms.heroTitle}
            </h1>
          </Reveal>

          <Reveal immediate delay={0.1}>
            <p className="max-w-2xl text-lg leading-relaxed text-muted-foreground">
              {mockCms.heroSubtitle}
            </p>
          </Reveal>

          <Reveal immediate delay={0.15}>
            <p className="max-w-xl text-base leading-relaxed text-muted-foreground">
              {mockCms.mission}
            </p>
          </Reveal>

          <Reveal immediate delay={0.2} className="flex flex-col gap-3 sm:flex-row">
            <ShinyLink href="/join">Вступить в партию</ShinyLink>
            <ShinyLink href="/reforms" variant="ghost">
              Программа партии
            </ShinyLink>
          </Reveal>
        </div>
      </section>

      {/* Pillars */}
      <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
        <SectionHeading
          eyebrow="Четыре опоры"
          title="На чём держится партия"
          // description="Каждое направление проверяется на районных собраниях, а не в кабинете."
        />

        <div className="mt-14 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {pillars.map((p, i) => (
            <Reveal key={p.title} delay={i * 0.06}>
              <SpotlightCard className="h-full">
                <p.icon className="h-7 w-7 text-primary" />
                <h3 className="mt-5 text-lg font-semibold leading-snug text-cloud">{p.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{p.text}</p>
              </SpotlightCard>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Milestones */}
      <section className="border-y border-border mx-5 my-24 bg-card/30">
        <div className="mx-auto flex max-w-7xl flex-wrap justify-center gap-10 px-5 py-20 sm:px-8">
          {dynamicMilestones.map((m, i) => (
            <Reveal 
              key={m.label} 
              delay={i * 0.06} 
              className="min-w-[200px] flex-1 max-w-[280px] text-center"
            >
              <p className="font-display text-4xl font-bold text-primary glow-text">
                <CountUp to={m.value} suffix={m.suffix} />
              </p>
              <p className="mt-3 text-sm text-muted-foreground">{m.label}</p>
            </Reveal>
          ))}
        </div>
      </section>

      {/* Transparency */}
      {/* <section className="mx-auto max-w-3xl px-5 py-24 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-3xl font-bold text-cloud sm:text-4xl">
            {mockCms.transparencyTitle}
          </h2>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="mt-5 text-base leading-relaxed text-muted-foreground">
            {mockCms.transparencyText}
          </p>
        </Reveal>
        <Reveal delay={0.16} className="mt-9">
          <Link
            href="/reforms"
            className="story-link inline-flex items-center gap-2 text-sm font-semibold text-primary hover:text-cloud"
          >
            Читать программу реформ
            <ArrowRight className="h-4 w-4" />
          </Link>
        </Reveal>
      </section> */}

      {/* Reforms */}
      {/* <section className="mx-auto max-w-7xl px-5 pb-24 sm:px-8">
        <SectionHeading eyebrow="Программа" title="Четыре реформы" />

        <div className="mt-14 grid gap-6 md:grid-cols-2">
          {reforms.map((r, i) => (
            <Reveal key={r.id} delay={i * 0.05}>
              <SpotlightCard className="h-full">
                <div className="flex items-center gap-3">
                  <r.icon className="h-6 w-6 text-primary" />
                  <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
                    {r.label}
                  </p>
                </div>
                <h3 className="mt-4 text-xl font-semibold leading-snug text-cloud">{r.title}</h3>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{r.summary}</p>
                <ul className="mt-5 space-y-2.5">
                  {r.points.map((point) => (
                    <li key={point} className="flex gap-2.5 text-sm text-muted-foreground">
                      <span aria-hidden className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
                      {point}
                    </li>
                  ))}
                </ul>
              </SpotlightCard>
            </Reveal>
          ))}
        </div>
      </section> */}

      {/* Feed */}
      <section className="border-y border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <SectionHeading eyebrow="Материалы" title="Свежие публикации и записи" />

          <div className="mt-14 grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {feed.map((item, i) => (
              <Reveal key={item.title} delay={i * 0.05}>
                <article className="flex h-full flex-col rounded-2xl border border-border bg-card p-6 transition-all duration-300 hover:-translate-y-1 hover:border-primary/50 hover:shadow-glow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <span className="rounded-full border border-border px-3 py-1 text-[11px] font-semibold uppercase tracking-widest text-primary">
                      {feedKindLabel[item.kind]}
                    </span>
                    {item.duration && (
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {item.duration}
                      </span>
                    )}
                  </div>
                  <h3 className="mt-4 text-lg font-semibold leading-snug text-cloud">{item.title}</h3>
                  <p className="mt-1.5 text-xs text-primary">{item.meta}</p>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
                    {item.excerpt}
                  </p>
                </article>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Upcoming events - live from the database, visible to everyone */}
      <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
        <SectionHeading
          eyebrow="Ближайшие события"
          title="Приходите на встречи и собрания"
          description="Все мероприятия открытые и бесплатные."
        />

        {upcoming.length === 0 ? (
          <p className="mt-12 text-sm text-muted-foreground">
            Расписание пока пустое. Актуальные даты появятся здесь сразу, как только
            координационный совет их объявит.
          </p>
        ) : (
          <ul className="mt-14 divide-y divide-border border-y border-border">
            {upcoming.map((event, i) => (
              <Reveal key={event.id} delay={i * 0.04}>
                <PublicEventRow event={event} />
              </Reveal>
            ))}
          </ul>
        )}
      </section>

      {/* Archive. Kept out of the invitation above on purpose: an outsider who sees
          a month-old meeting under "come to our meetings" clicks it, finds a date
          in the past, and concludes the party is finished. Showing the history is
          still worth it - "we clean the park on Saturdays" is a recruiting
          argument - as long as it is labelled as history. */}
      {past.length > 0 && (
        <section className="border-t border-border bg-card/20">
          <div className="mx-auto max-w-7xl px-5 py-16 sm:px-8">
            <SectionHeading
              eyebrow="Архив"
              title="Прошедшие встречи"
              description="Что уже было. Записаться на прошлое, конечно, нельзя."
            />

            <ul className="mt-12 divide-y divide-border border-y border-border">
              {past.map((event, i) => (
                <Reveal key={event.id} delay={i * 0.04}>
                  <PublicEventRow event={event} muted />
                </Reveal>
              ))}
            </ul>
          </div>
        </section>
      )}

      {/* Manifesto */}
      <section className="border-t border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <SectionHeading eyebrow="Манифест" title="Обещаем только то, что можем сделать" />

          <div className="mt-14 grid gap-6 md:grid-cols-3">
            {manifesto.map((m, i) => (
              <Reveal key={m.title} delay={i * 0.07}>
                <SpotlightCard className="h-full">
                  <h3 className="font-display text-xl font-bold text-cloud">{m.title}</h3>
                  <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{m.text}</p>
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* Leadership */}
      <section className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
      <SectionHeading
        eyebrow="Руководство"
        title="Кто ведёт партию"
        align="center"
      />

      <div className="mx-auto mt-14 flex flex-wrap justify-center gap-6">
        {leaders.map((l, i) => (
          <Reveal key={l.name} delay={i * 0.05} className="w-full max-w-sm">
            <div className="flex h-full flex-col rounded-2xl border border-border bg-card p-6">
              <span className="font-display text-2xl font-bold text-primary glow-text">
                {l.initials}
              </span>
              <h3 className="mt-4 text-base font-semibold text-cloud">{l.name}</h3>
              <p className="mt-1 text-xs text-primary">{l.role}</p>
              <p className="mt-3 flex-1 text-sm leading-relaxed text-muted-foreground">{l.bio}</p>
              <div className="mt-4 flex flex-wrap gap-1.5">
                {l.focus.map((f) => (
                  <span
                    key={f}
                    className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground"
                  >
                    {f}
                  </span>
                ))}
              </div>
            </div>
          </Reveal>
        ))}
      </div>
    </section>

      {/* Chronicle */}
      <section className="border-t border-border bg-card/30">
        <div className="mx-auto max-w-4xl px-5 py-24 sm:px-8">
          <SectionHeading eyebrow="Хроника" title="С 2018 года" />

          <div className="mt-14">
            <Timeline items={chronicle} />
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-3xl px-5 py-28 text-center sm:px-8">
        <Reveal>
          <h2 className="font-display text-3xl font-bold text-cloud sm:text-4xl">
            Власть принадлежит гражданам
          </h2>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="mx-auto mt-5 max-w-md text-base leading-relaxed text-muted-foreground">
            Вступайте в партию - наш офис работает на Фраклин 9.
          </p>
        </Reveal>
        <Reveal delay={0.16} className="mt-9">
          <ShinyLink href="/join">Вступить в партию</ShinyLink>
        </Reveal>
      </section>
    </>
  );
}

/**
 * One event in the public list.
 *
 * The state badge is not decoration. `status` in the database answers "did staff
 * close this", which stays `open` forever on a meeting nobody remembered to
 * finish - so a badge built from it would tell a stranger to turn up to last
 * Tuesday's assembly. The badge is derived from the clock in the DAL and arrives
 * as `publicState`.
 *
 * `muted` is used in the archive so a past meeting cannot compete visually with an
 * invitation.
 */
function PublicEventRow({ event, muted = false }: { event: PublicEvent; muted?: boolean }) {
  return (
    <li
      className={`grid gap-3 py-6 sm:grid-cols-[9rem_1fr_auto] sm:items-start sm:gap-6 ${
        muted ? "opacity-70" : ""
      }`}
    >
      <div>
        {/* Rendered as a <time> element so the machine-readable datetime is
            available to crawlers and to anything reading the page for a schedule,
            not just sighted humans. */}
        <time dateTime={event.startsAt} className="font-display text-lg font-bold text-primary">
          {formatEventDay(event.startsAt)}
        </time>
        <p className="mt-0.5 text-xs capitalize text-muted-foreground">
          {formatEventWeekday(event.startsAt)}
        </p>
      </div>

      <div className="min-w-0">
        <h3 className="text-base font-semibold text-cloud">{event.title}</h3>

        <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 shrink-0 text-primary" />
            {formatEventTimeRange(event.startsAt, event.endsAt)}
          </span>

          {event.location && (
            <span className="inline-flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
              {event.location}
            </span>
          )}

          {event.createdByName && (
            <span className="inline-flex items-center gap-1.5">
              <User className="h-3.5 w-3.5 shrink-0 text-primary" />
              Организовал: {event.createdByName}
            </span>
          )}
        </div>

        {event.description && (
          <p className="mt-2 line-clamp-3 text-sm leading-relaxed text-muted-foreground">
            {event.description}
          </p>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 sm:flex-col sm:items-end">
        <span
          className={`inline-flex w-fit items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${PUBLIC_STATE_CLASSES[event.publicState]}`}
        >
          {PUBLIC_STATE_LABELS[event.publicState]}
        </span>
        {/* Kept alongside the state badge rather than replaced by it: whether an
            event counts towards worked hours is a different question from when it
            happens, and a member deciding whether to come needs both. It was
            briefly commented out while the state badge was added, which quietly
            dropped it from the card entirely. */}
        {event.trackHours ? (
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground">
            <CalendarDays className="h-3 w-3" />
            С учётом часов
          </span>
        ) : null}
      </div>
    </li>
  );
}
