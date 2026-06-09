import { buyUrl, TOKEN } from "@/lib/config";

export function BuyButton({
  size = "md",
  variant = "primary",
  className = "",
  label,
}: {
  size?: "md" | "lg";
  variant?: "primary" | "ghost";
  className?: string;
  label?: string;
}): React.JSX.Element {
  return (
    <a
      href={buyUrl()}
      target="_blank"
      rel="noreferrer"
      className={`btn ${variant === "primary" ? "btnPrimary" : "btnGhost"} ${size === "lg" ? "btnLg" : ""} ${className}`.trim()}
    >
      {label ?? `Buy ${TOKEN.symbol}`}
      <span aria-hidden>↗</span>
    </a>
  );
}
