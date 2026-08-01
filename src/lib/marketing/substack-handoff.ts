const SUBSTACK_MARKDOWN_MAX = 250_000;
const SUBSTACK_TITLE_MAX = 200;

export interface SubstackRichText {
  /** The reviewed Markdown remains the audit source; this is a derived copy surface. */
  html: string;
  plainText: string;
}

export interface SubstackDraftView {
  title: string;
  subtitle?: string;
  bodyMarkdown: string;
  tags: string[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function canonicalHandoffLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:"
      || url.username
      || url.password
      || url.port
    ) return null;

    const openZapsAllowed = ["www.0xzaps.com", "0xzaps.com"].includes(
      url.hostname,
    );
    const substackAllowed =
      url.hostname === "defitutorials.substack.com"
      && !url.search
      && !url.hash
      && (
        url.pathname === "/"
        || url.pathname === "/feed"
        || /^\/p\/[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?\/?$/u.test(
          url.pathname,
        )
      );
    const githubPath = url.pathname.toLowerCase();
    const githubAllowed =
      url.hostname === "github.com"
      && (githubPath === "/0pen-zaps/openzaps"
        || githubPath.startsWith("/0pen-zaps/openzaps/"));
    return openZapsAllowed || substackAllowed || githubAllowed
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function inlineRichText(raw: string): SubstackRichText {
  let html = "";
  let plainText = "";
  let index = 0;

  const appendText = (value: string): void => {
    html += escapeHtml(value);
    plainText += value;
  };

  while (index < raw.length) {
    if (raw[index] === "`") {
      const end = raw.indexOf("`", index + 1);
      if (end > index + 1) {
        const value = raw.slice(index + 1, end);
        html += `<code>${escapeHtml(value)}</code>`;
        plainText += value;
        index = end + 1;
        continue;
      }
    }

    if (raw.startsWith("**", index)) {
      const end = raw.indexOf("**", index + 2);
      if (end > index + 2) {
        const value = raw.slice(index + 2, end);
        html += `<strong>${escapeHtml(value)}</strong>`;
        plainText += value;
        index = end + 2;
        continue;
      }
    }

    if (raw[index] === "*") {
      const end = raw.indexOf("*", index + 1);
      if (end > index + 1) {
        const value = raw.slice(index + 1, end);
        html += `<em>${escapeHtml(value)}</em>`;
        plainText += value;
        index = end + 1;
        continue;
      }
    }

    if (raw[index] === "[") {
      const labelEnd = raw.indexOf("](", index + 1);
      const urlEnd = labelEnd === -1 ? -1 : raw.indexOf(")", labelEnd + 2);
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const label = raw.slice(index + 1, labelEnd);
        const rawUrl = raw.slice(labelEnd + 2, urlEnd);
        const url = canonicalHandoffLink(rawUrl);
        if (url) {
          html += `<a href="${escapeHtml(url)}">${escapeHtml(label)}</a>`;
          plainText += `${label} (${url})`;
          index = urlEnd + 1;
          continue;
        }
      }
    }

    const codePoint = raw.codePointAt(index);
    if (codePoint === undefined) break;
    const character = String.fromCodePoint(codePoint);
    appendText(character);
    index += character.length;
  }

  return { html, plainText };
}

function startsBlock(line: string): boolean {
  return (
    /^```(?:[A-Za-z0-9_-]{0,32})?\s*$/u.test(line)
    || /^#{1,3}[ \t]+\S/u.test(line)
    || /^\s*(?:---|\*\*\*)\s*$/u.test(line)
    || /^>\s?/u.test(line)
    || /^[-*][ \t]+\S/u.test(line)
    || /^\d{1,4}[.)][ \t]+\S/u.test(line)
  );
}

/**
 * Converts a deliberately small Markdown subset to pasteable rich text.
 *
 * Supported blocks: headings, paragraphs, blockquotes, flat ordered/unordered
 * lists, thematic breaks, and fenced code. Supported inline syntax: strong,
 * emphasis, code, and links to canonical OpenZaps/DeFi Tutorials sources.
 * Raw HTML and unsupported links are escaped and remain visible as text.
 */
export function prepareSubstackRichText(markdown: string): SubstackRichText {
  if (!markdown.trim() || markdown.length > SUBSTACK_MARKDOWN_MAX) {
    throw new Error(
      `Substack Markdown must be 1-${SUBSTACK_MARKDOWN_MAX} characters.`,
    );
  }

  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  const html: string[] = [];
  const plain: string[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(?:[A-Za-z0-9_-]{0,32})?\s*$/u);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/u.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const value = code.join("\n");
      html.push(`<pre><code>${escapeHtml(value)}</code></pre>`);
      plain.push(value);
      continue;
    }

    const heading = line.match(/^(#{1,3})[ \t]+(.+)$/u);
    if (heading) {
      const content = inlineRichText(heading[2].trim());
      const level = heading[1].length === 3 ? 3 : 2;
      html.push(`<h${level}>${content.html}</h${level}>`);
      plain.push(content.plainText);
      index += 1;
      continue;
    }

    if (/^\s*(?:---|\*\*\*)\s*$/u.test(line)) {
      html.push("<hr>");
      plain.push("---");
      index += 1;
      continue;
    }

    if (/^>\s?/u.test(line)) {
      const quote: string[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^>\s?(.*)$/u);
        if (!match) break;
        quote.push(match[1]);
        index += 1;
      }
      const content = inlineRichText(quote.join(" ").trim());
      html.push(`<blockquote><p>${content.html}</p></blockquote>`);
      plain.push(`> ${content.plainText}`);
      continue;
    }

    if (/^[-*][ \t]+\S/u.test(line)) {
      const items: SubstackRichText[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^[-*][ \t]+(.+)$/u);
        if (!match) break;
        items.push(inlineRichText(match[1].trim()));
        index += 1;
      }
      html.push(`<ul>${items.map((item) => `<li>${item.html}</li>`).join("")}</ul>`);
      plain.push(items.map((item) => `• ${item.plainText}`).join("\n"));
      continue;
    }

    if (/^\d{1,4}[.)][ \t]+\S/u.test(line)) {
      const items: SubstackRichText[] = [];
      while (index < lines.length) {
        const match = lines[index].match(/^\d{1,4}[.)][ \t]+(.+)$/u);
        if (!match) break;
        items.push(inlineRichText(match[1].trim()));
        index += 1;
      }
      html.push(`<ol>${items.map((item) => `<li>${item.html}</li>`).join("")}</ol>`);
      plain.push(items.map((item, itemIndex) => `${itemIndex + 1}. ${item.plainText}`).join("\n"));
      continue;
    }

    const paragraph = [line.trim()];
    index += 1;
    while (
      index < lines.length
      && lines[index].trim()
      && !startsBlock(lines[index])
    ) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    const content = inlineRichText(paragraph.join(" "));
    html.push(`<p>${content.html}</p>`);
    plain.push(content.plainText);
  }

  return {
    html: html.join("\n"),
    plainText: plain.join("\n\n"),
  };
}

export function canonicalSubstackPostUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:"
      || url.hostname !== "defitutorials.substack.com"
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || !/^\/p\/[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?\/?$/u.test(
        url.pathname,
      )
    ) return null;
    url.pathname = url.pathname.replace(/\/$/u, "");
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizeSubstackTitle(raw: string): string | null {
  const title = raw.trim().replace(/\s+/gu, " ");
  return title && Array.from(title).length <= SUBSTACK_TITLE_MAX ? title : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonemptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function nonemptySourceText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Safely narrows the persisted workflow payload before it reaches the UI. */
export function substackDraftView(value: unknown): SubstackDraftView | null {
  const candidate = record(value);
  if (!candidate) return null;
  const title = normalizeSubstackTitle(nonemptyText(candidate.title) ?? "");
  const bodyMarkdown =
    nonemptySourceText(candidate.bodyMarkdown)
    ?? nonemptySourceText(candidate.body);
  if (!title || !bodyMarkdown || bodyMarkdown.length > SUBSTACK_MARKDOWN_MAX) {
    return null;
  }
  const subtitle = nonemptyText(candidate.subtitle);
  const tags = Array.isArray(candidate.tags)
    ? candidate.tags.flatMap((tag) => {
        const normalized = nonemptyText(tag);
        return normalized && Array.from(normalized).length <= 32 ? [normalized] : [];
      }).slice(0, 5)
    : [];
  return {
    title,
    ...(subtitle && Array.from(subtitle).length <= 300 ? { subtitle } : {}),
    bodyMarkdown,
    tags,
  };
}
