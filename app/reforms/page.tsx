import type { Metadata } from "next";
import { Check } from "lucide-react";
import { Reveal } from "@/components/ui/reveal";
import { SectionHeading } from "@/components/ui/section-heading";
import { SpotlightCard } from "@/components/ui/spotlight-card";
import { ShinyLink } from "@/components/ui/shiny-button";
import { reforms } from "@/data/content";
import { mockCms } from "@/data/mockData";

export const metadata: Metadata = {
  title: "Реформы",
  description: "Полная программа реформ: муниципальная прозрачность, право, экономика, обратная связь.",
};

export default function ReformsPage() {
  return (
    <>
      {/* <section className="mx-auto max-w-3xl px-5 py-24 sm:px-8">
        <Reveal immediate>
          <p className="text-xs font-semibold uppercase tracking-[0.3em] text-primary">
            Программа
          </p>
          <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-cloud sm:text-5xl">
            {mockCms.transparencyTitle}
          </h1>
        </Reveal>
        <Reveal immediate delay={0.08}>
          <p className="mt-6 text-lg leading-relaxed text-muted-foreground">
            {mockCms.transparencyText}
          </p>
        </Reveal>
      </section> */}

      {reforms.map((r, i) => (
        <section
          key={r.id}
          className={i % 2 === 1 ? "border-y border-border bg-card/30" : undefined}
        >
          <div className="mx-auto max-w-5xl px-5 py-20 sm:px-8">
            <Reveal>
              <div className="flex items-center gap-3">
                <r.icon className="h-6 w-6 text-primary" />
                <p className="text-xs font-semibold uppercase tracking-[0.2em] text-primary">
                  {r.label}
                </p>
              </div>
              <h2 className="mt-4 font-display text-2xl font-bold text-cloud sm:text-3xl">
                {r.title}
              </h2>
              <p className="mt-4 max-w-2xl text-base leading-relaxed text-muted-foreground">
                {r.summary}
              </p>
            </Reveal>

            <div className="mt-10 grid gap-8 md:grid-cols-2">
              <Reveal delay={0.06}>
                <h3 className="text-sm font-semibold uppercase tracking-widest text-cloud">
                  Что мы делаем
                </h3>
                <ul className="mt-4 space-y-3">
                  {r.points.map((point) => (
                    <li key={point} className="flex gap-3 text-sm leading-relaxed text-muted-foreground">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                      {point}
                    </li>
                  ))}
                </ul>
              </Reveal>

              <Reveal delay={0.12}>
                <SpotlightCard className="h-full">
                  <h3 className="text-sm font-semibold uppercase tracking-widest text-cloud">
                    Что это даёт вам
                  </h3>
                  <ul className="mt-4 space-y-3">
                    {r.forYou.map((item) => (
                      <li
                        key={item}
                        className="flex gap-3 text-sm leading-relaxed text-muted-foreground"
                      >
                        <span
                          aria-hidden
                          className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                        />
                        {item}
                      </li>
                    ))}
                  </ul>
                </SpotlightCard>
              </Reveal>
            </div>
          </div>
        </section>
      ))}

      {/* <section className="mx-auto max-w-3xl px-5 py-28 text-center sm:px-8">
        <SectionHeading
          eyebrow="Следующий шаг"
          title="Вступайте - наш офис на Франклин 9"
          align="center"
        />
        <Reveal className="mt-9">
          <ShinyLink href="/join">Вступить в движение</ShinyLink>
        </Reveal>
      </section> */}
    </>
  );
}
