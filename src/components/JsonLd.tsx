import { jsonLd } from "@/lib/seo";

/**
 * Renders schema.org structured data as an inline JSON-LD script.
 *
 * Safety: `data` is always a build-time literal (no user input reaches this component), and
 * `jsonLd()` escapes `<` to its unicode form (backslash-u003c) per the Next.js JSON-LD guide
 * (node_modules/next/dist/docs/01-app/02-guides/json-ld.md), which names this exact
 * pattern as the recommended implementation. A native <script> tag is intentional —
 * next/script is for executable JS, not structured data. Keep this the ONLY place in the
 * app that renders raw HTML.
 */
export function JsonLd({ data }: { data: object }): React.JSX.Element {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(data) }} />;
}
