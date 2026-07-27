import type { Metadata } from "next";

import { ProfileDashboard } from "./ProfileDashboard";
import { pageMetadata } from "@/lib/seo";

export const metadata = {
  ...pageMetadata({
    title: "My Zaps",
    description:
      "Connect a wallet to inspect its confirmed OpenZaps history, monitor recurring and price-triggered authorizations, and access supported recovery controls.",
    path: "/profile",
    ogImage: "/og/app.png",
  }),
  robots: {
    index: false,
    follow: true,
    googleBot: { index: false, follow: true },
  },
} satisfies Metadata;

export default function ProfilePage(): React.JSX.Element {
  return <ProfileDashboard />;
}
