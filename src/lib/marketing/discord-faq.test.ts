import { describe, expect, it } from "vitest";

import { answerOpenZapsFaq } from "@/lib/marketing/discord-faq";

describe("answerOpenZapsFaq", () => {
  it("states the bounded authority model for agent questions", () => {
    const answer = answerOpenZapsFaq("Can I connect an AI agent?");
    expect(answer.topic).toBe("agent");
    expect(answer.content).toContain("gets the trigger");
    expect(answer.content).toContain("cannot change");
    expect(answer.content).toContain("Pre-audit");
  });

  it("does not market a live deployment as audited", () => {
    const answer = answerOpenZapsFaq("Is OpenZaps audited and safe?");
    expect(answer.topic).toBe("audit");
    expect(answer.content).toContain("have not completed an external audit");
    expect(answer.content).toContain("Live does not mean production-cleared");
  });

  it("routes security reports privately without asking for secrets", () => {
    const answer = answerOpenZapsFaq("I found a vulnerability");
    expect(answer.topic).toBe("security");
    expect(answer.content).toContain("private vulnerability reporting");
    expect(answer.content).toContain("Never send a private key");
  });

  it("keeps the token separate from protocol rights", () => {
    const answer = answerOpenZapsFaq("Does the token give me yield?");
    expect(answer.topic).toBe("token");
    expect(answer.content).toContain("does not imply yield");
    expect(answer.content).toContain("Not financial advice");
  });
});
