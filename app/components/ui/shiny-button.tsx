import Link, { type LinkProps } from "next/link";
import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ShinyVariant = "primary" | "ghost";

const base =
  "group relative inline-flex items-center justify-center gap-2 overflow-hidden rounded-full px-6 py-3 text-sm font-semibold transition-all duration-300 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98]";

const variants: Record<ShinyVariant, string> = {
  primary:
    "bg-primary text-primary-foreground shadow-glow-sm hover:shadow-glow hover:-translate-y-0.5",
  ghost:
    "border border-border bg-card/60 text-foreground backdrop-blur hover:border-primary/60 hover:-translate-y-0.5 hover:bg-card",
};

function Sheen({ variant }: { variant: ShinyVariant }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 -translate-x-full bg-gradient-to-r from-transparent to-transparent transition-transform duration-700 ease-out group-hover:translate-x-full",
        variant === "primary" ? "via-cloud/50" : "via-primary/25",
      )}
    />
  );
}

export function ShinyLink({
  variant = "primary",
  className,
  children,
  ...props
}: Omit<LinkProps, "href"> & {
  href: string;
  variant?: ShinyVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Link className={cn(base, variants[variant], className)} {...props}>
      <Sheen variant={variant} />
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </Link>
  );
}

export function ShinyButton({
  variant = "primary",
  className,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ShinyVariant }) {
  return (
    <button className={cn(base, variants[variant], className)} {...props}>
      <Sheen variant={variant} />
      <span className="relative z-10 inline-flex items-center gap-2">{children}</span>
    </button>
  );
}
