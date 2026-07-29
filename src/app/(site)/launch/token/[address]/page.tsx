import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getAddress, isAddress, type Address } from "viem";

import { TokenConsole } from "@/components/zappad/token-console";
import { pageMetadata } from "@/lib/seo";

import styles from "../../zappad.module.css";

type TokenPageProps = {
  params: Promise<{ address: string }>;
};

function parseTokenAddress(value: string): Address {
  if (!isAddress(value)) notFound();
  return getAddress(value);
}

export async function generateMetadata({ params }: TokenPageProps): Promise<Metadata> {
  const token = parseTokenAddress((await params).address);
  const shortToken = `${token.slice(0, 8)}…${token.slice(-6)}`;

  return {
    ...pageMetadata({
      title: `Check ZapPad Address ${shortToken}`,
      description:
        "Check whether this Robinhood Chain address is a canonical ZapPad token launch before relying on its market, launch parameters, fee-share vault, or wallet claims.",
      path: `/launch/token/${token.toLowerCase()}`,
      keywords: [
        "ZapPad address check",
        "fee-share vault verification",
        "token launch verification",
      ],
      ogImage: "/og/app.png",
    }),
    // The client verifies canonical launcher membership after runtime config
    // loads. Until that same proof is enforced server-side, arbitrary valid
    // addresses must not become indexable "ZapPad Token" pages.
    robots: { index: false, follow: true },
  };
}

export default async function ZapPadTokenPage({
  params,
}: TokenPageProps): Promise<React.JSX.Element> {
  const token = parseTokenAddress((await params).address);

  return (
    <main className={styles.screen} id="main" data-screen-label="ZapPad">
      <div className={styles.tokenPage}>
        <TokenConsole token={token} />
      </div>
    </main>
  );
}
