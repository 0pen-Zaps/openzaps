import type { Metadata } from "next";
import { TOKEN } from "@/lib/config";

export const metadata: Metadata = {
  title: "App",
  description: `Build an immutable OpenZap intent locker — fund it, sign a policy, let Hermes run it. ${TOKEN.symbol} powers the network.`,
  alternates: { canonical: "/app" },
};

export default function AppLayout({ children }: { children: React.ReactNode }): React.JSX.Element {
  return children as React.JSX.Element;
}
