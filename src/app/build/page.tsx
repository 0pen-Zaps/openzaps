import { JsonLd } from "@/components/JsonLd";
import { SHAPE_COLOR, SHAPE_LABEL, type FlowShape } from "@/lib/blocks";
import { breadcrumbJsonLd, pageMetadata } from "@/lib/seo";
import { ZapBuilder } from "./ZapBuilder";
import styles from "./build.module.css";

export const metadata = pageMetadata({
  title: "Builder — design a zap from typed DeFi blocks",
  description:
    "Drag DeFi blocks — swaps, lending, liquidity, bridges, yield, and guards — into a chain. Every block declares its connectors, so a joint seats only where the shapes match. Nothing here signs, funds, or broadcasts anything.",
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
        <h1>A block only seats where the shapes match.</h1>
        <p>
          Every DeFi activity here is a block that declares its connectors: a source emits a shape, a settlement
          block takes one, and everything between does both. A joint seats only when the shape leaving the block
          above is the shape the block below takes, so dragging cannot assemble a mismatched chain. A shared link
          can still carry one, and the readout names the joint that does not fit.
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
