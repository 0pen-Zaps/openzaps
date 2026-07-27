import { SITE_NAME, SITE_URL } from "@/lib/seo";

export const dynamic = "force-static";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<OpenSearchDescription xmlns="http://a9.com/-/spec/opensearch/1.1/">
  <ShortName>${SITE_NAME} Zaps</ShortName>
  <Description>Open a verified OpenZaps Zap by contract address</Description>
  <InputEncoding>UTF-8</InputEncoding>
  <Language>en-US</Language>
  <AdultContent>false</AdultContent>
  <Image height="192" width="192" type="image/png">${SITE_URL}/icon-192.png</Image>
  <Url type="text/html" template="${SITE_URL}/explore/{searchTerms}" />
  <Url type="application/opensearchdescription+xml" rel="self" template="${SITE_URL}/opensearch.xml" />
</OpenSearchDescription>
`;

export function GET(): Response {
  return new Response(xml, {
    headers: {
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
      "Content-Type": "application/opensearchdescription+xml; charset=utf-8",
    },
  });
}
