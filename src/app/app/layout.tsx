import { JsonLd } from "@/components/JsonLd";
import { TOKEN, CHAIN } from "@/lib/config";
import { pageMetadata, absoluteUrl, SITE_URL, SITE_NAME } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "App — build immutable intent lockers",
  description: `Build an immutable OpenZap intent locker on ${CHAIN.name} — fund it, sign an EIP-712 policy, let Hermes run it. ${TOKEN.symbol} powers the network.`,
  path: "/app",
  keywords: ["OpenZaps app", "create zap", "intent locker app", "DeFi automation app", "EIP-712 policy signer"],
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
      description: `Build immutable OpenZap intent lockers for agent-triggered DeFi on ${CHAIN.name}.`,
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
