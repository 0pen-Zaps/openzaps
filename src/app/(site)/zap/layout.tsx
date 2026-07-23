import { JsonLd } from "@/components/JsonLd";
import { CHAIN } from "@/lib/config";
import { pageMetadata, absoluteUrl, SITE_URL, SITE_NAME } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Zap — design, sign, and run onchain zaps",
  description: `Design a zap from typed DeFi blocks, then create, fund, sign, execute, and recover it on ${CHAIN.name} — swaps, stitched multi-pool routes, and aeWETH/USDG liquidity. The contracts have not been externally audited. Deposited funds are at risk.`,
  path: "/zap",
  ogImage: "/og/app.png",
  keywords: ["use OpenZaps", "policy capsule builder", "simulate DeFi policy", "DeFi automation app", "EIP-712 policy review"],
});

const appJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": absoluteUrl("/zap#software"),
      name: `${SITE_NAME} App`,
      url: absoluteUrl("/zap"),
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${SITE_URL}/#organization` },
      description: `Design zaps from typed DeFi blocks, then create, fund, execute, and recover OpenZap policy capsules on ${CHAIN.name} — swaps, stitched multi-pool routes, and aeWETH/USDG liquidity. The recipient is fixed to the capsule owner and the relayer fee cap is zero.`,
    },
    {
      "@type": "BreadcrumbList",
      "@id": absoluteUrl("/zap#breadcrumbs"),
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "Zap", item: absoluteUrl("/zap") },
      ],
    },
  ],
};

export default function AppLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <>
      <JsonLd data={appJsonLd} />
      {children}
    </>
  );
}
