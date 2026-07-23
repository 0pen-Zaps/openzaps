import { SHAPE_COLOR, SHAPE_LABEL, type FlowShape } from "@/lib/blocks";
import buildStyles from "./build.module.css";

const SHAPES: FlowShape[] = ["token", "lp", "receipt", "yield", "debt"];

/**
 * The Design view's intro. A separate, server-renderable component so the /use
 * page can prerender it as the Suspense fallback: without it the static shell
 * for the whole surface was literally empty (the client wrapper reads
 * useSearchParams), which is a blank first paint and nothing for crawlers.
 */
export function DesignHero(): React.JSX.Element {
  return (
    <section className={`container ${buildStyles.hero}`}>
      <span className="eyebrow">Zap builder</span>
      <h1>Design it here. Sign it one tab over.</h1>
      <p>
        Every DeFi activity is a block that declares its connectors, so a joint seats only where the shapes
        match. When a design reduces to a deployable route, the readout hands it straight to{" "}
        <strong>Sign &amp; run</strong> — same page, nothing submitted until you sign.
      </p>
      <div className={buildStyles.legend}>
        {SHAPES.map((shape) => (
          <span className={buildStyles.legendItem} key={shape}>
            <i style={{ background: SHAPE_COLOR[shape] }} />
            {SHAPE_LABEL[shape]}
          </span>
        ))}
      </div>
    </section>
  );
}
