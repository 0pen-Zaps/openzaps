import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  // 308s keep every inbound link — a shared URL, a search result, a bookmark, an
  // onchain-minted capsule link — landing on the page that now holds what it
  // used to, rather than on a 404. Next.js forwards the incoming query string,
  // so /use?d=… and /use?view=sign carry through to /zap intact.
  //   /use            → /zap               the action surface was renamed
  //   /zaps           → /explore           the feed was renamed
  //   /zaps/<address> → /explore/<address> per-capsule pages moved with it
  //   /dashboard      → /explore           older fold into the feed
  //   /app            → /zap?view=sign     the signing console, now a /zap view
  //   /build          → /zap               the visual builder, now a /zap view
  //   /security       → /docs#security     folded into the docs
  //   /pricing        → /docs              removed; docs are the surviving reference
  async redirects() {
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "0xzaps.com" }],
        destination: "https://www.0xzaps.com/:path*",
        permanent: true,
      },
      // The retired game surface shipped under both Overdraw and ZapDraw.
      // Every legacy URL resolves directly to the surviving simulation surface
      // so old links keep working without a redirect chain.
      { source: "/zapdraw", destination: "/virtual-trading", permanent: true },
      { source: "/zapdraw/how", destination: "/virtual-trading", permanent: true },
      { source: "/overdraw", destination: "/virtual-trading", permanent: true },
      { source: "/overdraw/how", destination: "/virtual-trading", permanent: true },
      { source: "/use", destination: "/zap", permanent: true },
      { source: "/zaps", destination: "/explore", permanent: true },
      { source: "/zaps/:address", destination: "/explore/:address", permanent: true },
      { source: "/dashboard", destination: "/explore", permanent: true },
      { source: "/app", destination: "/zap?view=sign", permanent: true },
      { source: "/build", destination: "/zap", permanent: true },
      { source: "/security", destination: "/docs#security", permanent: true },
      { source: "/pricing", destination: "/docs", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [
          {
            key: "X-Robots-Tag",
            value: "noindex, nofollow, nosnippet",
          },
        ],
      },
      {
        source: "/marketing",
        headers: [
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors 'none'",
          },
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "Referrer-Policy",
            value: "no-referrer",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
        ],
      },
    ];
  },
};

export default withWorkflow(nextConfig);
