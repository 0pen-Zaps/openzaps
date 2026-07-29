import type { ReactNode } from "react";

export function PageHero({
  eyebrow,
  title,
  intro,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  intro: string;
  actions?: ReactNode;
}) {
  return (
    <section className="page-hero">
      <div className="eyebrow">{eyebrow}</div>
      <h1>{title}</h1>
      <p>{intro}</p>
      {actions && <div className="hero-actions">{actions}</div>}
    </section>
  );
}
