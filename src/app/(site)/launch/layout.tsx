import { ZapPadFeatureProvider } from "@/components/zappad/feature-provider";

import { ZapPadFeatureNav } from "./ZapPadFeatureNav";
import styles from "./zappad.module.css";

/**
 * ZapPad is an OpenZaps feature, so this layout adds only feature context and
 * the launchpad runtime provider. The parent `(site)` layout remains the sole
 * owner of application chrome, wallet authority, scrolling, and the footer.
 */
export default function ZapPadLayout({
  children,
}: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  return (
    <ZapPadFeatureProvider>
      <section className={styles.featureFrame} aria-label="ZapPad token launchpad">
        <ZapPadFeatureNav />
        {children}
      </section>
    </ZapPadFeatureProvider>
  );
}
