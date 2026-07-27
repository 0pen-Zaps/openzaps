import buildStyles from "./build.module.css";

/**
 * The Compose screen's head.
 *
 * A separate, server-renderable component so the /zap page can prerender it as
 * the Suspense fallback: without it the static shell for the whole surface was
 * literally empty (the client wrapper reads useSearchParams), which is a blank
 * first paint and nothing for crawlers.
 *
 * The connector-shape legend that used to sit here moved into the palette rail,
 * beside the port dots it actually explains.
 */
export function DesignHero(): React.JSX.Element {
  return (
    <div className={buildStyles.head} data-screen-label="Compose">
      <h1>Compose</h1>
      <p>
        Build the flow, see the bounds, sign when it is right. Nothing touches your wallet until you continue to
        Zap now or Automate.
      </p>
    </div>
  );
}
