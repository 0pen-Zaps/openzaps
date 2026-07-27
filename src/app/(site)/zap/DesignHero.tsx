import { SHAPE_COLOR, SHAPE_LABEL, type FlowShape } from "@/lib/blocks";
import buildStyles from "./build.module.css";

const SHAPES: FlowShape[] = ["token", "lp", "receipt", "yield", "debt"];

/**
 * The Design view's intro. A separate, server-renderable component so the /zap
 * page can prerender it as the Suspense fallback: without it the static shell
 * for the whole surface was literally empty (the client wrapper reads
 * useSearchParams), which is a blank first paint and nothing for crawlers.
 */
export function DesignHero(): React.JSX.Element {
  return (
    <section className={`container ${buildStyles.hero}`}>
      <div className={buildStyles.heroGrid}>
        <div className={buildStyles.heroCopy}>
          <span className="eyebrow">Visual Zap builder</span>
          <h1>Build the flow. See the bounds. Sign when it’s right.</h1>
          <p>
            Start from a blueprint or compose your own flow. OpenZaps checks connector fit, guard coverage,
            live-route support, and fees while you build. <strong>Nothing touches your wallet</strong> until you
            continue to Zap now or Automate.
          </p>
          <a className={buildStyles.heroCta} href="#zap-workspace">
            Start building
            <span aria-hidden="true">↓</span>
          </a>
        </div>
        <ol className={buildStyles.heroSteps} aria-label="From idea to wallet">
          <li>
            <span>01</span>
            <div>
              <strong>Compose</strong>
              <p>Load a blueprint or connect policy blocks that fit.</p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Review</strong>
              <p>Check every connector, guard, live route, fee, and limitation.</p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Authorize</strong>
              <p>Carry exact route values into Zap now or automation policy into Automate.</p>
            </div>
          </li>
        </ol>
      </div>
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
