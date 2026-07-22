import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Three routes were removed or folded together. These 308s keep every inbound
  // link — a shared URL, a search result, a bookmark — landing on the page that
  // now holds what it used to, rather than on a 404.
  //   /dashboard  merged into the Zaps Feed at /zaps
  //   /security   folded into the docs, at the #security anchor
  //   /pricing    removed; the docs are the surviving product reference
  // A destination hash is served in the Location header and honoured by the
  // browser, so /security lands on the security cluster, not just the docs top.
  async redirects() {
    return [
      { source: "/dashboard", destination: "/zaps", permanent: true },
      { source: "/security", destination: "/docs#security", permanent: true },
      { source: "/pricing", destination: "/docs", permanent: true },
    ];
  },
};

export default nextConfig;
