import type { Metadata } from "next";
import { Quote } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import { SectionHeading } from "@/components/ui/section-heading";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { Timeline } from "@/components/modules/cms/timeline";
import { ShinyLink } from "@/components/ui/shiny-button";
import { SITE_NAME, chronicle, leaderTimeline, leaders } from "@/data/content";

export const metadata: Metadata = {
  title: "О партии",
  description: "История, руководство и движения Доброграда.",
};

export default function AboutPage() {
  return (
    <>
      <section className="mx-auto max-w-3xl px-5 py-24 sm:px-8">
        <Reveal immediate>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
            {SITE_NAME} · Доброград
          </p>
          <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-cloud sm:text-5xl">
            О партии
          </h1>
        </Reveal>
        <Reveal immediate delay={0.08}>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            «Свобода» -  независимая политическая организация Доброграда, объединившая профессионалов ради системных перемен. 
            Мы создали партию для защиты интересов горожан, независимости правосудия и помощи жителям в решении городских проблем.
          </p>
        </Reveal>
        <Reveal immediate delay={0.16} className="mt-9">
          <ShinyLink href="/join">Вступить в партию</ShinyLink>
        </Reveal>
      </section>

      <section className="border-y border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-5 py-24 sm:px-8">
          <SectionHeading eyebrow="Руководство" title="Кто ведёт партию" />

          <div className="mt-14 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
            {leaders.map((l, i) => (
              <Reveal key={l.name} delay={i * 0.05}>
                <SpotlightCard className="h-full">
                  <span className="font-display text-2xl font-bold text-primary glow-text">
                    {l.initials}
                  </span>
                  <h3 className="mt-4 text-base font-semibold text-cloud">{l.name}</h3>
                  <p className="mt-1 text-xs text-primary">{l.role}</p>
                  <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{l.bio}</p>
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
                </SpotlightCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-4xl px-5 py-24 sm:px-8">
        <SectionHeading eyebrow="Председатель" title="Путь Леонардо Мартинеса" />

        <Reveal className="mt-14">
          <figure className="rounded-2xl border border-border bg-card p-8">
            <Quote className="h-7 w-7 text-primary" />
            <blockquote className="mt-4 text-lg leading-relaxed text-cloud">
              «Чем ближе крах империи, тем безумнее её законы. Мы здесь для того, 
              чтобы защитить права каждого гражданина».
            </blockquote>
          </figure>
        </Reveal>

        <div className="mt-12">
          <Timeline items={leaderTimeline} />
        </div>
      </section>

      <section className="border-t border-border bg-card/30">
        <div className="mx-auto max-w-4xl px-5 py-24 sm:px-8">
          <SectionHeading eyebrow="История" title="Как мы росли" />
          <div className="mt-14">
            <Timeline items={chronicle} />
          </div>
        </div>
      </section>
    </>
  );
}
