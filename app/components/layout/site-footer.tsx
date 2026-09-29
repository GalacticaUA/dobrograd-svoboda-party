import Link from "next/link";
import { AtSign, Mail, MapPin, Phone, Send, Video, GlobeCode, UsersRound } from "lucide-react";
import { BirdLogo } from "@/components/layout/bird-logo";

export function SiteFooter() {
  return (
    <footer className="relative mt-24 border-t border-border bg-card/40">
      <div className="pointer-events-none absolute inset-x-0 -top-px h-px bg-gradient-to-r from-transparent via-primary/60 to-transparent" />
      <div className="mx-auto grid max-w-7xl gap-12 px-5 py-16 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
        <div>
          <BirdLogo />
          <p className="mt-5 max-w-sm text-sm leading-relaxed text-muted-foreground">
            Партия «Свобода» - независимая политическая организация Доброграда. 
            Мы выступаем за реформу местной власти, развитие частного предпринимательства и прямое участие жителей в принятии городских решений.
          </p>
          <div className="mt-6 flex gap-3">
            {[
              { Icon: Send, label: "Telegram" },
              { Icon: Video, label: "YouTube" },
              { Icon: AtSign, label: "Сообщество" },
            ].map(({ Icon, label }) => (
              <a
                key={label}
                href="https://forum.octothorp.team/topic/13599/%D0%BF%D0%B0%D1%80%D1%82%D0%B8%D1%8F-%D1%81%D0%B2%D0%BE%D0%B1%D0%BE%D0%B4%D0%B0"
                aria-label={label}
                className="rounded-full border border-border p-2.5 text-muted-foreground transition-all hover:-translate-y-0.5 hover:border-primary hover:text-primary hover:shadow-glow-sm"
              >
                <Icon className="h-4 w-4" />
              </a>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-sm font-semibold uppercase tracking-widest text-cloud">Навигация</h3>
          <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
            <li><Link href="/about" className="story-link hover:text-cloud">О движении и руководство</Link></li>
            <li><Link href="/reforms" className="story-link hover:text-cloud">Реформы и программа</Link></li>
            <li><Link href="/join" className="story-link hover:text-cloud">Гражданская приёмная</Link></li>
            {/* <li><Link href="/join" className="story-link hover:text-cloud">Стать волонтёром</Link></li> */}
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-semibold uppercase tracking-widest text-cloud">Часы приёмной</h3>
          <ul className="mt-4 space-y-2.5 text-sm text-muted-foreground">
            <li>Пн - Пт · 10:00 – 19:00</li>
            <li>Суббота · 11:00 – 15:00</li>
            {/* <li>Юрпомощь · Ср 17:00 – 20:00</li> */}
            <li className="text-primary">Всегда бесплатно.</li>
          </ul>
        </div>

        <div>
          <h3 className="text-sm font-semibold uppercase tracking-widest text-cloud">Контакты</h3>
          <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
            <li className="flex gap-2.5"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> ул. Франклин, 9, Доброград</li>
            <li className="flex gap-2.5"><Phone className="h-4 w-4 shrink-0 text-primary" /> +1 (231) 547-4000</li>
            <li className="flex gap-2.5"><Mail className="h-4 w-4 shrink-0 text-primary" /> svoboda@ldp-freedom.org</li>
            <li className="flex gap-2.5"><GlobeCode className="h-4 w-4 shrink-0 text-primary" /> <a href="https://forum.octothorp.team/topic/13599/%D0%BF%D0%B0%D1%80%D1%82%D0%B8%D1%8F-%D1%81%D0%B2%D0%BE%D0%B1%D0%BE%D0%B4%D0%B0" className="story-link hover:text-cloud">Форум</a></li>
            <li className="flex gap-2.5"><UsersRound className="h-4 w-4 shrink-0 text-primary" /> <a href="https://discord.gg/PZUnuNvjtt" className="story-link hover:text-cloud">Discord</a></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-border/60">
        <div className="mx-auto flex max-w-7xl flex-col gap-2 px-5 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-8">
          <p>© 2018-2026 ЛДП «Свобода», Доброград. Финансируется исключительно взносами участников.</p>
          <p>Работаем с районными сообществами с 2018 года.</p>
        </div>
      </div>
    </footer>
  );
}
