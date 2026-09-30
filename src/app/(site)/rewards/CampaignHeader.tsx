import type { ReactNode } from "react";

import styles from "./campaigns.module.css";

type CampaignHeaderProps = {
  campaign: string;
  status: string;
  live: boolean;
  window: string;
  titleId: string;
  titleLevel: 1 | 2;
  title: string;
  description: string;
  children?: ReactNode;
};

/** Shared campaign identity and summary block for campaigns 1–3. */
export function CampaignHeader({
  campaign,
  status,
  live,
  window,
  titleId,
  titleLevel,
  title,
  description,
  children,
}: CampaignHeaderProps): React.JSX.Element {
  const Heading = titleLevel === 1 ? "h1" : "h2";

  return (
    <header className={styles.overview}>
      <div className={styles.overviewMain}>
        <div className={styles.overviewMeta}>
          <span className={styles.overviewCampaign}>{campaign}</span>
          <span className={styles.overviewStatus} data-live={live ? "" : undefined}>
            <i aria-hidden />
            {status}
          </span>
          <span className={styles.overviewWindow}>{window}</span>
        </div>
        <Heading id={titleId} className={styles.overviewTitle}>
          {title}
        </Heading>
        <p className={styles.overviewLede}>{description}</p>
      </div>
      {children ? <aside className={styles.overviewAside}>{children}</aside> : null}
    </header>
  );
}
