import type { Metadata } from "next";
import { Clock, MapPin, Phone } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import { SectionHeading } from "@/components/ui/section-heading";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { ShinyLink } from "@/components/ui/shiny-button";
import { ApplicationForm } from "@/components/auth/application-form";
import { getSessionProfile } from "@/lib/auth/dal";

export const metadata: Metadata = {
  title: "Гражданская приёмная",
  description: "Как вступить в движение, где мы работаем и когда открыта приёмная.",
};

const hours = [
  { day: "Пн - Пт", time: "10:00 – 19:00" },
  { day: "Суббота", time: "11:00 – 15:00" },
  { day: "Юрпомощь", time: "Ср 17:00 – 20:00" },
];

export default async function JoinPage() {
  // Prefilled, not required. A person removed from the party keeps their Steam
  // account and can still sign in, so the form has their ID to hand - and that
  // ID is what a reviewer approves, which is how the old profile and its hours
  // come back instead of a fresh empty one being created under a typo.
  const session = await getSessionProfile();
  const defaultSteamId = session.ok ? session.profile.steamId : "";

  return (
    <>
      <section className="mx-auto max-w-3xl px-5 py-24 sm:px-8">
        <Reveal immediate>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
            Гражданская приёмная
          </p>
          <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-cloud sm:text-5xl">
            Стать работником
          </h1>
        </Reveal>
        <Reveal immediate delay={0.08}>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            Развитие партии строится на реальном участии специалистов и активных горожан.
            <br />
            Нам требуются юристы, аналитики, организаторы.
            <br />
            Заполните анкету - мы свяжемся с вами, определим формат работы.
          </p>
        </Reveal>
        <Reveal immediate delay={0.16} className="mt-9">
          <ShinyLink href="https://docs.google.com/forms/d/e/1FAIpQLSeA5zppgYMnRUlCqJUbaSBo3I2OUHZq9drpyWoFZ6FSiwZ_rA/viewform">Написать в приёмную</ShinyLink>
        </Reveal>
      </section>

      {/* <section id="application" className="mx-auto max-w-3xl scroll-mt-24 px-5 pb-24 sm:px-8">
        <Reveal immediate>
          <SectionHeading
            eyebrow="Анкета"
            title="Подать заявку"
            description="Заявка попадает в очередь координационного совета. Решение принимает человек, а не эта страница."
          />
        </Reveal>
        <Reveal immediate delay={0.08} className="mt-10">
          <ApplicationForm defaultSteamId={defaultSteamId} />
        </Reveal>
      </section> */}

      <section className="border-y border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <SectionHeading eyebrow="Приёмная" title="Когда и где мы работаем" />

          <div className="mt-14 grid gap-6 md:grid-cols-3">
            <Reveal>
              <SpotlightCard className="h-full">
                <MapPin className="h-6 w-6 text-primary" />
                <h3 className="mt-4 text-lg font-semibold text-cloud">Адрес</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  ул. Франклин, 9, Доброград
                </p>
              </SpotlightCard>
            </Reveal>
            <Reveal delay={0.06}>
              <SpotlightCard className="h-full">
                <Clock className="h-6 w-6 text-primary" />
                <h3 className="mt-4 text-lg font-semibold text-cloud">Часы приёма</h3>
                <ul className="mt-2 space-y-1.5">
                  {hours.map((h) => (
                    <li key={h.day} className="flex justify-between gap-4 text-sm">
                      <span className="text-muted-foreground">{h.day}</span>
                      <span className="tabular-nums text-cloud">{h.time}</span>
                    </li>
                  ))}
                </ul>
              </SpotlightCard>
            </Reveal>
            <Reveal delay={0.12}>
              <SpotlightCard className="h-full">
                <Phone className="h-6 w-6 text-primary" />
                <h3 className="mt-4 text-lg font-semibold text-cloud">Связь</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  +1 (231) 547-4000
                  <br />
                  svoboda@ldp-freedom.org
                </p>
              </SpotlightCard>
            </Reveal>
          </div>

          <Reveal className="mt-10">
            <p className="text-sm font-semibold text-primary">Всегда бесплатно.</p>
          </Reveal>
        </div>
      </section>

      {/* <section className="mx-auto max-w-4xl px-5 py-24 sm:px-8">
        <SectionHeading
          eyebrow="Ближайшие встречи"
          title="Приходите без записи"
          description="Открытые встречи во всех районах Доброграда."
        />

        <ul className="mt-12 divide-y divide-border border-y border-border">
          {events.map((e) => (
            <li
              key={`${e.date}-${e.title}`}
              className="grid gap-2 py-6 sm:grid-cols-[7rem_1fr_auto] sm:items-center sm:gap-6"
            >
              <p className="font-display text-lg font-bold text-primary">{e.date}</p>
              <div className="min-w-0">
                <h3 className="text-base font-semibold text-cloud">{e.title}</h3>
                <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
                  {e.place}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                <span className="rounded-full border border-border px-2.5 py-1">{e.type}</span>
                <span className="rounded-full border border-border px-2.5 py-1">{e.district}</span>
                <span className="tabular-nums">{e.time}</span>
              </div>
            </li>
          ))}
        </ul>

        <Reveal className="mt-12">
          <div className="rounded-2xl border border-border bg-card p-8">
            <h3 className="font-display text-xl font-bold text-cloud">Районы, где мы работаем</h3>
            <div className="mt-4 flex flex-wrap gap-2">
              {districtOptions.map((d) => (
                <span
                  key={d}
                  className="rounded-full border border-border px-3.5 py-1.5 text-sm text-muted-foreground"
                >
                  {d}
                </span>
              ))}
            </div>
          </div>
        </Reveal>
      </section> */}
    </>
  );
}
