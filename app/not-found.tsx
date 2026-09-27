import { ShinyLink } from "@/components/ui/shiny-button";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-2xl flex-col items-center gap-6 px-5 py-32 text-center sm:px-8">
      <p className="font-display text-7xl font-bold text-primary glow-text">404</p>
      <h1 className="font-display text-2xl font-bold text-cloud sm:text-3xl">
        Такой страницы нет
      </h1>
      <p className="text-base leading-relaxed text-muted-foreground">
        Возможно, адрес изменился или страницу ещё не написали. Нам нужен только один двор,
        чтобы начать.
      </p>
      <ShinyLink href="/">На главную</ShinyLink>
    </div>
  );
}
