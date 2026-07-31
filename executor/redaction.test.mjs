import assert from "node:assert/strict";
import { test } from "node:test";

import {
  redactExecutorText,
  registerExecutorSensitiveValues,
} from "./redaction.mjs";

test("redaction covers decoded URL paths, suffixes, userinfo, and short components", () => {
  registerExecutorSensitiveValues({
    urls: [
      "https://user%40name:pass%2Fword@rpc-encoded.example/rpc/provider%2Fcredential-marker/abcd",
    ],
  });

  const diagnostic = redactExecutorText(
    "provider error for provider/credential-marker with user@name, pass/word, and abcd",
  );
  for (const secret of [
    "provider/credential-marker",
    "user@name",
    "pass/word",
    "abcd",
  ]) {
    assert.ok(!diagnostic.includes(secret));
  }
  assert.ok(diagnostic.includes("[redacted]"));
});
