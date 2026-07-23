import { type ProtocolId, type ProtocolInfo } from "@/lib/protocols";

/**
 * Round protocol marks for the builder's "what does this block touch" badges.
 *
 * Every mark is an original geometric interpretation drawn in the protocol's
 * recognizable brand colour — a droplet, a ring, a wing — never a traced copy
 * of a trademarked logo. They are tuned for 14–18 px: one shape per mark, no
 * strokes thinner than the ring, nothing that needs more than a glance.
 *
 * The site's default ground is near-black, so every glyph sits on the same
 * subtle plate — a `rgba(255,255,255,0.06)` disc with a 1px
 * `rgba(255,255,255,0.12)` ring — which is what keeps the darker brand
 * colours (Aerodrome's blue, the bridge grey) legible without brightening
 * them away from their identities. The ring uses `non-scaling-stroke` so it
 * stays exactly 1px however the 24-unit viewBox is scaled.
 *
 * No hooks, no state, no CSS module: everything is inline SVG attributes, so
 * the marks render identically on the server and inside any caller.
 */

/** OpenZaps sodium accent — `--accent` in globals.css. */
const OPENZAPS_ACCENT = "#ccf83f";
const UNISWAP_PINK = "#FF007A";

/**
 * Glyphs, drawn in a 24×24 box with the plate at r=11. Static JSX on purpose:
 * a mark takes no props, so one element per protocol is all React ever needs.
 */
const MARK: Record<ProtocolId, React.JSX.Element> = {
  // Stylized droplet — the pool, not the unicorn.
  "uniswap-v4": (
    <path
      d="M12 5.2 C14.6 8.6 16.8 10.9 16.8 13.6 A4.8 4.8 0 0 1 7.2 13.6 C7.2 10.9 9.4 8.6 12 5.2 Z"
      fill={UNISWAP_PINK}
    />
  ),
  // Same pink, hollow: the ring reads "previous version" next to the filled v4 drop.
  "uniswap-v3": <circle cx={12} cy={12} r={4.6} fill="none" stroke={UNISWAP_PINK} strokeWidth={2.4} />,
  // Swept wing.
  aerodrome: <path d="M4.8 15.2 L12 7.4 L19.2 15.2 L12 11.9 Z" fill="#2545D3" />,
  // Bolt-in-circle — the OpenZapMark silhouette, solid because scanlines
  // do not survive 14 px.
  "openzaps-vault": <path d="M13.4 4.6 L7.2 13.2 L11 13.2 L10 19.4 L16.8 10.6 L12.8 10.6 Z" fill={OPENZAPS_ACCENT} />,
  // Twin triangles, wings apart.
  morpho: (
    <g fill="#2E7CF6">
      <path d="M10.9 12 L5.6 7.7 L5.6 16.3 Z" />
      <path d="M13.1 12 L18.4 7.7 L18.4 16.3 Z" />
    </g>
  ),
  // Two-tone dome, split down the middle.
  aave: (
    <g>
      <path d="M12 5.8 A6.2 6.2 0 0 0 5.8 12 L5.8 16.6 L12 16.6 Z" fill="#B6509E" />
      <path d="M12 5.8 A6.2 6.2 0 0 1 18.2 12 L18.2 16.6 L12 16.6 Z" fill="#2EBAC6" />
    </g>
  ),
  // Three stacked bars, middle offset.
  compound: (
    <g fill="#00D395">
      <rect x={6} y={6.6} width={10} height={2.7} rx={1.35} />
      <rect x={8} y={10.7} width={10} height={2.7} rx={1.35} />
      <rect x={6} y={14.8} width={10} height={2.7} rx={1.35} />
    </g>
  ),
  // Neutral arch: span plus piers, no brand to borrow.
  "canonical-bridge": (
    <path
      d="M6.2 16.4 L6.2 13.2 A5.8 5.8 0 0 1 17.8 13.2 L17.8 16.4"
      fill="none"
      stroke="#9BA3AE"
      strokeWidth={2.2}
      strokeLinecap="round"
    />
  ),
  // ETH-blue diamond, outline only — wrapped, not the asset itself.
  "wrapped-native": (
    <path d="M12 4.8 L17.4 12 L12 19.2 L6.6 12 Z" fill="none" stroke="#627EEA" strokeWidth={1.8} strokeLinejoin="round" />
  ),
};

/**
 * One mark. The SVG itself is aria-hidden: labeling happens exactly once, at
 * whatever wraps it — the stack below, or a caller that renders a lone mark
 * and owns its own text. Three stacked labels (svg aria-label + <title> +
 * wrapper title) made every badge announce its name three times over.
 */
export function ProtocolLogo({ protocol, size = 14 }: { protocol: ProtocolId; size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {/* r=11, not 11.5: the 1px non-scaling ring must stay inside the box at 14 px. */}
      <circle
        cx={12}
        cy={12}
        r={11}
        fill="rgba(255,255,255,0.06)"
        stroke="rgba(255,255,255,0.12)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {MARK[protocol]}
    </svg>
  );
}

/**
 * A row of marks, slightly overlapped, and nothing else visual — the caller
 * owns any text label that follows. The stack announces itself ONCE ("via
 * Uniswap v4 + OpenZaps vault"); each mark keeps a `title` tooltip for mouse
 * hover only, and the SVGs themselves are aria-hidden. Empty arrays render
 * nothing at all rather than an empty span pushing on the layout.
 */
export function ProtocolStack({ protocols, size = 14 }: { protocols: ProtocolInfo[]; size?: number }): React.JSX.Element | null {
  if (protocols.length === 0) return null;
  return (
    <span
      role="img"
      aria-label={`via ${protocols.map((protocol) => protocol.name).join(" + ")}`}
      style={{ display: "inline-flex", alignItems: "center" }}
    >
      {protocols.map((protocol, index) => (
        <span
          key={protocol.id}
          title={protocol.name}
          style={{ display: "inline-flex", lineHeight: 0, marginLeft: index === 0 ? 0 : -size * 0.3 }}
        >
          <ProtocolLogo protocol={protocol.id} size={size} />
        </span>
      ))}
    </span>
  );
}
