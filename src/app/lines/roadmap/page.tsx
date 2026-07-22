import type { Metadata } from "next";
import { LinesFooter, LinesNav, LinesRibbon } from "../LinesChrome";
import { LinesSection, PageHero } from "../LinesSections";
import { PAGES } from "../pages";
import styles from "../lines.module.css";

const CONTENT = PAGES.roadmap;

export const metadata: Metadata = {
  title: "Roadmap — LINES preview",
  description: CONTENT.lede.slice(0, 160),
};

export default function LinesRoadmapPage(): React.JSX.Element {
  return (
    <>
      <LinesRibbon />
      <LinesNav current="/lines/roadmap" />
      {/* The site-wide skip link in the root layout targets #main, so every
          page that renders its own <main> has to carry the id or the very
          first thing a keyboard user presses does nothing. */}
      <main id="main" className={styles.shell}>
        <PageHero kicker={CONTENT.kicker} title={CONTENT.title} lede={CONTENT.lede} />
        {CONTENT.sections.map((section) => (
          <LinesSection key={section.heading} section={section} />
        ))}
      </main>
      <LinesFooter />
    </>
  );
}
