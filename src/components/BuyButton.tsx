import Link from "next/link";

import { buyUrl, LINKS, TOKEN } from "@/lib/config";

type BuyDestination = "clanker" | "openzaps";

export function BuyButton({
  size = "md",
  variant = "primary",
  className = "",
  label,
  destination = "clanker",
}: {
  size?: "md" | "lg";
  variant?: "primary" | "ghost";
  className?: string;
  label?: string;
  destination?: BuyDestination;
}): React.JSX.Element {
  const classes = `btn ${variant === "primary" ? "btnPrimary" : "btnGhost"} ${size === "lg" ? "btnLg" : ""} ${className}`.trim();
  const content = (
    <>
      {label ?? (destination === "openzaps" ? `Zap in to ${TOKEN.symbol}` : `Buy ${TOKEN.symbol}`)}
      <span aria-hidden>{destination === "openzaps" ? "→" : "↗"}</span>
    </>
  );

  if (destination === "openzaps") {
    return (
      <Link className={classes} href={LINKS.buyWithOpenZaps}>
        {content}
      </Link>
    );
  }

  return (
    <a
      href={buyUrl()}
      target="_blank"
      rel="noreferrer"
      className={classes}
    >
      {content}
    </a>
  );
}
