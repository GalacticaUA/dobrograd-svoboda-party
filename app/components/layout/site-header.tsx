"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { BirdLogo } from "@/components/layout/bird-logo";
import { ShinyLink } from "@/components/ui/shiny-button";
import { cn } from "@/lib/utils";

const nav = [
  { to: "/", label: "Главная" },
  { to: "/about", label: "О партии" },
  { to: "/reforms", label: "Реформы" },
  { to: "/join", label: "Приёмная" },
] as const;

export function SiteHeader({ authSlot }: { authSlot?: ReactNode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  const isActive = (to: string) =>
    to === "/" ? pathname === to : pathname === to || pathname.startsWith(`${to}/`);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 12);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 transition-all duration-1500",
        scrolled ? "border-b border-border/70 bg-background/75 backdrop-blur-xl" : "bg-transparent",
      )}
    >
      <div className="mx-auto flex h-18 max-w-7xl items-center justify-between gap-3 px-5 sm:px-8">
        <Link href="/" aria-label="ЛДП «Свобода» - на главную" onClick={() => setOpen(false)}>
          <BirdLogo compact />
        </Link>

        <nav className="hidden items-center gap-8 md:flex" aria-label="Main">
          {nav.map((n) => (
            <Link
              key={n.to}
              href={n.to}
              className={cn(
                "story-link text-sm font-medium transition-colors hover:text-cloud",
                isActive(n.to) ? "text-cloud after:scale-x-100" : "text-muted-foreground",
              )}
            >
              {n.label}
            </Link>
          ))}
        </nav>

        <div className="hidden items-center gap-3 md:flex">
          <ShinyLink href="/join" className="px-5 py-2.5">
            Вступить в партию
          </ShinyLink>
          {authSlot}
        </div>

        <button
          className="rounded-md p-2 text-cloud md:hidden"
          aria-label={open ? "Закрыть меню" : "Открыть меню"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X /> : <Menu />}
        </button>
      </div>

      <div
        className={cn(
          "grid overflow-hidden border-b border-border bg-background/95 backdrop-blur-xl transition-all duration-300 md:hidden",
          open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
        )}
      >
        <div className="min-h-0">
          <nav className="flex flex-col gap-1 px-5 py-4" aria-label="Mobile">
            {nav.map((n) => (
              <Link
                key={n.to}
                href={n.to}
                onClick={() => setOpen(false)}
                className={cn(
                  "rounded-lg px-3 py-3 text-base font-medium transition-colors hover:bg-card hover:text-cloud",
                  isActive(n.to) ? "bg-card text-cloud" : "text-muted-foreground",
                )}
              >
                {n.label}
              </Link>
            ))}
            <div className="pt-3">
              <ShinyLink href="/join" className="w-full" onClick={() => setOpen(false)}>
                Вступить в партию
              </ShinyLink>
            </div>
          </nav>
        </div>
      </div>
    </header>
  );
}
