import { Reveal } from "@/components/ui/reveal";

export function Timeline({ items }: { items: { year: string; title: string; text: string }[] }) {
  return (
    <ol className="relative ml-3 border-l border-border">
      {items.map((it, i) => (
        <li key={it.year + it.title} className="relative pb-10 pl-8 last:pb-0">
          <Reveal delay={i * 0.05}>
            <span className="absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full bg-primary shadow-glow-sm" />
            <p className="font-display text-sm font-semibold tracking-widest text-primary">{it.year}</p>
            <h3 className="mt-1 text-lg font-semibold text-cloud">{it.title}</h3>
            <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{it.text}</p>
          </Reveal>
        </li>
      ))}
    </ol>
  );
}
