import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  RequestZapForm,
  requestSubmissionErrorMessage,
  requestValidationMessage,
} from "./RequestZapForm";

const PROPS = {
  attribution: { landingPath: "/request-a-zap" as const },
  initialValues: {},
};

const styles = readFileSync(
  fileURLToPath(new URL("./request-a-zap.module.css", import.meta.url)),
  "utf8",
);

describe("RequestZapForm deployment boundary", () => {
  it("sends preview visitors to the canonical production form", () => {
    const markup = renderToStaticMarkup(
      createElement(RequestZapForm, {
        ...PROPS,
        isPreviewDeployment: true,
      }),
    );

    expect(markup).toContain("Preview deployment");
    expect(markup).toContain(
      'href="https://www.0xzaps.com/request-a-zap#request-form"',
    );
    expect(markup).not.toContain("Request my Zap review");
    expect(markup).not.toContain('name="email"');
  });

  it("keeps the real intake form enabled outside Vercel previews", () => {
    const markup = renderToStaticMarkup(createElement(RequestZapForm, PROPS));

    expect(markup).toContain("Request my Zap review");
    expect(markup).toContain('name="email"');
    expect(markup).toContain("noValidate");
    expect(markup).not.toContain("Preview deployment");
  });

  it("keeps persona cards directly selectable and the honeypot out of autofill", () => {
    const markup = renderToStaticMarkup(createElement(RequestZapForm, PROPS));
    const personaInputRule = styles.match(/\.personaCard input\s*\{([^}]*)\}/u)?.[1];

    expect(markup).toContain('for="lead-persona-agent_builder"');
    expect(markup).toContain('id="lead-persona-agent_builder"');
    expect(markup).toContain('data-1p-ignore="true"');
    expect(markup).toContain('data-lpignore="true"');
    expect(markup).toContain('data-bwignore="true"');
    expect(personaInputRule).toMatch(/inset:\s*0/u);
    expect(personaInputRule).toMatch(/width:\s*100%/u);
    expect(personaInputRule).toMatch(/height:\s*100%/u);
    expect(personaInputRule).toMatch(/opacity:\s*0/u);
  });

  it("returns actionable validation messages for the first invalid field", () => {
    expect(requestValidationMessage("persona")).toBe(
      "Choose which path describes you before sending the request.",
    );
    expect(requestValidationMessage("projectUrl")).toBe(
      "Use a secure project URL beginning with https://, or leave it blank.",
    );
    expect(requestValidationMessage(null)).toBe(
      "Complete every required field marked with an asterisk before sending.",
    );
  });

  it("describes the durable daily quota truthfully", () => {
    expect(requestSubmissionErrorMessage(429)).toBe(
      "This network reached today's request limit. Try again after the daily UTC reset, or contact us in Discord if the request is urgent.",
    );
    expect(requestSubmissionErrorMessage(503)).toContain(
      "temporarily unavailable",
    );
  });
});
