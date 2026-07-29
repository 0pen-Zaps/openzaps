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

  return pageMetadata({
    title: `ZapPad Token ${shortToken}`,
    description:
      "Verify this ZapPad token launch, opening Uniswap pool, immutable launch parameters, fee-share vault, and connected-wallet claims.",
    path: `/launch/token/${token.toLowerCase()}`,
    keywords: ["ZapPad token console", "fee-share vault", "verified token launch"],
    ogImage: "/og/app.png",
  });
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
