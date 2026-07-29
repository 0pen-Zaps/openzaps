const X_USERNAME = "[A-Za-z0-9_]{1,15}";
const X_POST_ID = "\\d{1,19}";
const CANONICAL_X_STATUS_URL = new RegExp(
  `^https://x\\.com/(${X_USERNAME})/status/(${X_POST_ID})$`,
  "u",
);

export interface CanonicalXStatusTarget {
  url: string;
  username: string;
  postId: string;
}

/**
 * Accept only the canonical public status shape. No www host, redirects,
 * query strings, fragments, credentials, alternate schemes, or trailing slash.
 */
export function parseCanonicalXStatusUrl(raw: string): CanonicalXStatusTarget {
  if (raw !== raw.trim()) {
    throw new Error("X target URL must not contain surrounding whitespace.");
  }
  const match = CANONICAL_X_STATUS_URL.exec(raw);
  if (!match) {
    throw new Error(
      "X target must be https://x.com/<user>/status/<1-19 digit id>.",
    );
  }
  return {
    url: raw,
    username: match[1],
    postId: match[2],
  };
}
