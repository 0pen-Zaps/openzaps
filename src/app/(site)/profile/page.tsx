import { ProfileDashboard } from "./ProfileDashboard";
import { pageMetadata } from "@/lib/seo";

export const metadata = pageMetadata({
  title: "Profile — zap history and automation control",
  description:
    "Connect a wallet to inspect its confirmed OpenZaps history across v1.1, v3, and v3.1, monitor recurring and price-triggered authorizations, revoke live automation, and recover capsule assets.",
  path: "/profile",
  keywords: [
    "OpenZaps profile",
    "zap activity history",
    "manage auto zaps",
    "Robinhood Chain wallet dashboard",
    "recurring zap control",
  ],
});

export default function ProfilePage(): React.JSX.Element {
  return <ProfileDashboard />;
}
