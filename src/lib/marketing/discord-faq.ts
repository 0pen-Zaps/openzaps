import { CHAIN, STATUS } from "@/lib/config";

export interface DiscordFaqAnswer {
  content: string;
  topic: "zap" | "agent" | "audit" | "security" | "token" | "general";
}

const DOCS = "https://www.0xzaps.com/docs";
const CONNECT = "https://www.0xzaps.com/zap?view=connect";
const SECURITY =
  "https://github.com/0pen-Zaps/openzaps/security/advisories/new";
const TOKEN = "https://www.0xzaps.com/token";

export function answerOpenZapsFaq(rawQuestion: string): DiscordFaqAnswer {
  const question = rawQuestion.trim().slice(0, 1_000);
  const normalized = question.toLowerCase();

  if (/\bwhat (?:is|are) (?:an? )?(?:open)?zap|how (?:does|do) (?:a )?zap\b/u.test(normalized)) {
    return {
      topic: "zap",
      content:
        "A Zap is an immutable policy capsule for one bounded DeFi action graph. Its target, recipient, assets, calldata, and execution policy are fixed before signing; a submitted run cannot widen those terms. " +
        `${DOCS}\n\nPre-audit software. Verify before use.`,
    };
  }
  if (/\bagent|executor|authority|session key|connect\b/u.test(normalized)) {
    return {
      topic: "agent",
      content:
        "An OpenZaps agent gets the trigger, never the owner's authority. A standing signed intent can name the executor address; the agent may submit a due run but cannot change its recipient, amount, cadence, floor, adapter, asset, or calldata. " +
        `${CONNECT}\n\nPre-audit software. Verify before use.`,
    };
  }
  if (/\baudit|audited|safe|production ready\b/u.test(normalized)) {
    return {
      topic: "audit",
      content: STATUS.preAudit
        ? `OpenZaps contracts are live on ${CHAIN.name} and have not completed an external audit. Live does not mean production-cleared. Review the current gates and risk disclosures here: ${DOCS}#gates\n\nPre-audit software. Verify before use.`
        : `OpenZaps contracts are live on ${CHAIN.name}. Verify the current audit report, deployment scope, and remaining gates here: ${DOCS}#gates`,
    };
  }
  if (/\bvulnerab|exploit|security report|bug bounty\b/u.test(normalized)) {
    return {
      topic: "security",
      content:
        "Please do not post vulnerability details publicly. Use GitHub private vulnerability reporting so maintainers can respond safely: " +
        SECURITY +
        "\n\nNever send a private key or seed phrase.",
    };
  }
  if (/\b0xzaps|token|price|buy|yield|revenue|governance\b/u.test(normalized)) {
    return {
      topic: "token",
      content:
        "0xZAPS is separate from protocol execution authority. It does not imply yield, equity, a revenue claim, governance, or protocol access. Verify the network and full contract address on the token page before any action: " +
        TOKEN +
        "\n\nNot financial advice.",
    };
  }
  return {
    topic: "general",
    content:
      "I can answer bounded OpenZaps questions about Zaps, agent authority, audit status, security reporting, or the 0xZAPS distinction. For the current technical reference, start here: " +
      DOCS +
      "\n\nPre-audit software. Verify before use.",
  };
}
