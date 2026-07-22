import { JsonLd } from "@/components/JsonLd";
import { TOKEN, CHAIN } from "@/lib/config";
import { pageMetadata, absoluteUrl, SITE_URL, SITE_NAME } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "App — create, fund, and execute a bounded capsule",
  description: `Connect a wallet on ${CHAIN.name} to quote, create, fund, execute, and recover a bounded aeWETH ↔ ${TOKEN.symbol} policy capsule. The contracts have not been externally audited. Deposited funds are at risk.`,
  path: "/app",
  ogImage: "/og/app.png",
  keywords: ["OpenZaps app", "policy capsule builder", "simulate DeFi policy", "DeFi automation app", "EIP-712 policy review"],
});

const appJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      "@id": absoluteUrl("/app#software"),
      name: `${SITE_NAME} App`,
      url: absoluteUrl("/app"),
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      publisher: { "@id": `${SITE_URL}/#organization` },
      description: `Create, fund, execute, and recover bounded aeWETH ↔ ${TOKEN.symbol} OpenZap policy capsules on ${CHAIN.name}. The recipient is fixed to the capsule owner and the relayer fee cap is zero.`,
    },
    {
      "@type": "BreadcrumbList",
      "@id": absoluteUrl("/app#breadcrumbs"),
      itemListElement: [
        { "@type": "ListItem", position: 1, name: SITE_NAME, item: SITE_URL },
        { "@type": "ListItem", position: 2, name: "App", item: absoluteUrl("/app") },
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
