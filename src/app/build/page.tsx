import { JsonLd } from "@/components/JsonLd";
import { SHAPE_COLOR, SHAPE_LABEL, type FlowShape } from "@/lib/blocks";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { ZapBuilder } from "./ZapBuilder";
import styles from "./build.module.css";

export const metadata = pageMetadata({
  title: "Builder — compose a zap from DeFi lego",
  description:
    "Drag and drop DeFi building blocks — swaps, lending, liquidity, bridges, yield, and guards — into a bounded zap. Every connector is typed, every chain compiles to a policy hash, and nothing is ever broadcast.",
  path: "/build",
  keywords: [
    "DeFi lego builder",
    "drag and drop DeFi",
    "visual zap builder",
    "compose DeFi strategy",
    "no-code onchain automation",
    "OpenZaps builder",
  ],
});

const SHAPES: FlowShape[] = ["token", "lp", "receipt", "yield", "debt"];

export default function BuildPage(): React.JSX.Element {
  return (
    <main className={styles.page} id="main">
      <JsonLd data={{ "@context": "https://schema.org", ...breadcrumbJsonLd("/build", "Builder") }} />

      <section className={`container ${styles.hero}`}>
        <span className="eyebrow">Zap builder</span>
        <h1>Snap a strategy together.</h1>
        <p>
          Every DeFi activity is a block with a typed connector. Drag pieces into the chain and they only seat where the
          shape flowing out of the block above matches the shape the block below expects — the same rule the policy
          compiler enforces before anything gets signed.
        </p>
        <div className={styles.legend}>
          {SHAPES.map((shape) => (
            <span className={styles.legendItem} key={shape}>
              <i style={{ background: SHAPE_COLOR[shape] }} />
              {SHAPE_LABEL[shape]}
            </span>
          ))}
        </div>
      </section>

      <div className="container">
        <ZapBuilder />
      </div>
    </main>
  );
}
