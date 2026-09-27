import bird from "@/assets/bird.png";
import { cn } from "@/lib/utils";

export function BirdMark({ className, glow = false }: { className?: string; glow?: boolean }) {
  return (
    <span
      role="img"
      aria-label="Взлетающая птица — эмблема ЛДП «Свобода»"
      className={cn("inline-block bg-primary", className)}
      style={{
        WebkitMaskImage: `url(${bird.src})`,
        maskImage: `url(${bird.src})`,
        WebkitMaskSize: "contain",
        maskSize: "contain",
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        filter: glow
          ? "drop-shadow(0 0 6px color-mix(in oklab, var(--primary) 95%, transparent)) drop-shadow(0 0 18px color-mix(in oklab, var(--primary) 70%, transparent))"
          : undefined,
      }}
    />
  );
}

export function BirdLogo({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <BirdMark className={compact ? "h-7 w-7" : "h-9 w-9"} glow />
      <span className="flex flex-col leading-none">
        <span
          className={cn(
            "animate-shine sky-gradient-text glow-text font-display font-bold tracking-tight",
            compact ? "text-lg" : "text-xl",
          )}
        >
          Свобода
        </span>
        <span className="text-[10px] uppercase tracking-[0.22em] text-muted-foreground">
          ЛДП · Доброград
        </span>
      </span>
    </span>
  );
}
