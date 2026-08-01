import { describe, expect, it } from "vitest";

import {
  canonicalSubstackPostUrl,
  prepareSubstackRichText,
  substackDraftView,
} from "./substack-handoff";

describe("Substack rich-text handoff", () => {
  it("derives semantic HTML and plain text from the supported Markdown subset", () => {
    const rich = prepareSubstackRichText(`# Intro

Paper trade **first**, then inspect \`maxRuns\`.

> The trigger never widens authority.

- Fix the target
- Fix the recipient

1. Open [Virtual Trading](https://www.0xzaps.com/virtual-trading)
2. Request a map

\`\`\`json
{"amount":"25"}
\`\`\``);

    expect(rich.html).toBe(`<h2>Intro</h2>
<p>Paper trade <strong>first</strong>, then inspect <code>maxRuns</code>.</p>
<blockquote><p>The trigger never widens authority.</p></blockquote>
<ul><li>Fix the target</li><li>Fix the recipient</li></ul>
<ol><li>Open <a href="https://www.0xzaps.com/virtual-trading">Virtual Trading</a></li><li>Request a map</li></ol>
<pre><code>{&quot;amount&quot;:&quot;25&quot;}</code></pre>`);
    expect(rich.plainText).toBe(`Intro

Paper trade first, then inspect maxRuns.

> The trigger never widens authority.

• Fix the target
• Fix the recipient

1. Open Virtual Trading (https://www.0xzaps.com/virtual-trading)
2. Request a map

{"amount":"25"}`);
  });

  it("escapes raw HTML and leaves unsupported or unsafe links visible as text", () => {
    const rich = prepareSubstackRichText(
      `<img src=x onerror=alert(1)> [bad](javascript:alert(1)) [external](https://attacker.example/post) [account](https://defitutorials.substack.com/account)`,
    );

    expect(rich.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(rich.html).toContain("[bad](javascript:alert(1))");
    expect(rich.html).toContain("[external](https://attacker.example/post)");
    expect(rich.html).toContain(
      "[account](https://defitutorials.substack.com/account)",
    );
    expect(rich.html).not.toContain("<img");
    expect(rich.html).not.toContain("href=");
  });

  it("rejects empty or oversized Markdown", () => {
    expect(() => prepareSubstackRichText("   ")).toThrow("1-250000");
    expect(() => prepareSubstackRichText("x".repeat(250_001))).toThrow(
      "1-250000",
    );
  });
});

describe("Substack handoff input narrowing", () => {
  it("accepts one exact canonical publication URL and strips its trailing slash", () => {
    expect(
      canonicalSubstackPostUrl(
        "https://defitutorials.substack.com/p/paper-trade-first/",
      ),
    ).toBe("https://defitutorials.substack.com/p/paper-trade-first");
  });

  it.each([
    "http://defitutorials.substack.com/p/post",
    "https://open.substack.com/pub/defitutorials/p/post",
    "https://defitutorials.substack.com/p/post?utm_source=test",
    "https://defitutorials.substack.com.evil.example/p/post",
    "https://defitutorials.substack.com/home/post",
  ])("rejects a non-canonical publication URL: %s", (url) => {
    expect(canonicalSubstackPostUrl(url)).toBeNull();
  });

  it("keeps the approved title, Markdown audit source, and bounded tags", () => {
    expect(
      substackDraftView({
        title: "  Paper Trade First  ",
        subtitle: "  Draw the authority map  ",
        body: "\n## Start\n\nNo wallet.\n",
        tags: [" OpenZaps ", "DeFi", "x".repeat(33)],
      }),
    ).toEqual({
      title: "Paper Trade First",
      subtitle: "Draw the authority map",
      bodyMarkdown: "\n## Start\n\nNo wallet.\n",
      tags: ["OpenZaps", "DeFi"],
    });
  });
});
