import { JsonLd } from "@/components/JsonLd";
import { CHAIN } from "@/lib/config";
import { pageMetadata, absoluteUrl, SITE_URL, SITE_NAME } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Zap now, recur, trigger, or compose",
  description: `Compose a DeFi route with signed gas, gas-price, and executor-access policy blocks, then Zap now, automate, monitor, revoke, or recover it on ${CHAIN.name}. Deposited funds are at risk.`,
  path: "/zap",
  ogImage: "/og/app.png",
  keywords: ["use OpenZaps", "policy capsule builder", "execution policy blocks", "simulate DeFi policy", "DeFi automation app", "EIP-712 policy review"],
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
      description: `Design zaps from typed DeFi route and execution-policy blocks, then Zap now, recur, or trigger them on ${CHAIN.name}. Signed intents bind execution gas and gas price; v3/v3.1 can keep executor access open or restrict it to the owner.`,
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
