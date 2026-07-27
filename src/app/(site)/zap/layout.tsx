import { JsonLd } from "@/components/JsonLd";
import { CHAIN } from "@/lib/config";
import {
  STATIC_PAGE_SEO,
  SITE_NAME,
  SITE_URL,
  absoluteUrl,
  breadcrumbJsonLd,
  pageMetadata,
  webPageJsonLd,
} from "@/lib/seo";

export const metadata = pageMetadata({
  ...STATIC_PAGE_SEO.zap,
  keywords: ["use OpenZaps", "policy capsule builder", "execution policy blocks", "simulate DeFi policy", "DeFi automation app", "EIP-712 policy review"],
});

const appJsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    webPageJsonLd(STATIC_PAGE_SEO.zap),
    {
      "@type": "SoftwareApplication",
      "@id": absoluteUrl("/zap#software"),
      name: `${SITE_NAME} DeFi Zap Builder`,
      url: absoluteUrl("/zap"),
      applicationCategory: "FinanceApplication",
      operatingSystem: "Web",
      publisher: { "@id": `${SITE_URL}/#organization` },
      mainEntityOfPage: { "@id": absoluteUrl("/zap#webpage") },
      softwareHelp: absoluteUrl("/docs"),
      browserRequirements: `A wallet compatible with ${CHAIN.name} is required for onchain execution.`,
      featureList: [
        "Bounded one-transaction DeFi zaps",
        "Visual composer for typed route and execution-policy blocks",
        "Recurring and price-triggered policy execution",
        "Deterministic policy simulation",
        "EIP-712 wallet signatures",
        "Immutable target, asset, recipient, and calldata constraints",
        "Onchain receipts, nonce invalidation, and emergency recovery",
      ],
      // The four surfaces the page actually mounts, in sidebar order.
      description: `Four surfaces on one page: Start picks the outcome, Compose builds the route and its execution policy from typed blocks, Zap now creates and runs a bounded v1.1 Zap contract, and Automate signs recurring or price-triggered ones on ${CHAIN.name}. Signed intents bind execution gas and gas price; v3/v3.1 can keep executor access open or restrict it to the owner.`,
    },
    breadcrumbJsonLd("/zap", "Zap"),
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
