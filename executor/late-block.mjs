// Final pre-broadcast chain admission for the executor.
//
// A viem fallback transport improves availability, but one request still comes from one node.
// That is not a quorum. This module deliberately queries independently configured RPC origins,
// agrees one recent canonical block, and (for capsule executions) repeats the exact eth_call at
// that block immediately before the signer lane is used.

const BLOCK_HASH = /^0x[0-9a-fA-F]{64}$/;

function blocked(outcome, detail) {
  return { allowed: false, outcome, detail };
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeInteger(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function simulationFingerprint(value) {
  if (value === undefined) return "undefined";
  return JSON.stringify(value, (_key, item) =>
    typeof item === "bigint" ? `${item}n` : item);
}

/**
 * Validate an environment-supplied JSON array without ever returning or logging URL text in an
 * error. Distinct URL origins are the minimum mechanically enforceable independence boundary;
 * operators must still verify that the origins are controlled by different node operators.
 */
export function parseLateBlockRpcUrls(value) {
  if (value === undefined || value === null || value === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("late-block RPC configuration must be a JSON array");
  }
  if (!Array.isArray(parsed) || parsed.length > 8) {
    throw new Error("late-block RPC configuration must contain at most 8 URLs");
  }

  const endpoints = [];
  const origins = new Set();
  for (const candidate of parsed) {
    if (typeof candidate !== "string") {
      throw new Error("late-block RPC entries must be URL strings");
    }
    let url;
    try {
      url = new URL(candidate);
    } catch {
      throw new Error("late-block RPC configuration contains an invalid URL");
    }
    const loopback =
      url.hostname === "127.0.0.1"
      || url.hostname === "localhost"
      || url.hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw new Error("late-block RPC URLs must use HTTPS (HTTP is allowed only for loopback)");
    }
    if (origins.has(url.origin)) {
      throw new Error("late-block RPC URLs must use distinct origins");
    }
    origins.add(url.origin);
    endpoints.push({ url: candidate, origin: url.origin });
  }
  return endpoints;
}

/**
 * Agree the parent-chain-derived finalized L2 boundary across independent nodes. A provider's
 * `finalized` label is still an assertion, so one endpoint never releases the durable signer
 * outbox by itself.
 */
export async function checkFinalizedBlockQuorum({
  clients,
  chainId,
  minimumAgreement = 2,
  maxHeadSkewBlocks = 128,
  maxBlockAgeSeconds = 3_600,
  maxFutureSkewSeconds = 30,
  nowSeconds = Math.floor(Date.now() / 1_000),
  blockTag = "finalized",
}) {
  const required = Math.max(2, positiveInteger(minimumAgreement, 2));
  const maxHeadSkew = nonNegativeInteger(maxHeadSkewBlocks, 128);
  const maxAge = positiveInteger(maxBlockAgeSeconds, 3_600);
  const maxFutureSkew = nonNegativeInteger(maxFutureSkewSeconds, 30);
  const configured = Array.isArray(clients) ? clients : [];
  if (configured.length < required) {
    return blocked(
      "finality-quorum-unavailable",
      `finality needs ${required} independent RPC origins; ${configured.length} configured`,
    );
  }

  const observed = await Promise.allSettled(
    configured.map(async (entry) => {
      const client = entry?.client ?? entry;
      const [observedChainId, block] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockTag }),
      ]);
      if (Number(observedChainId) !== Number(chainId)) throw new Error("wrong chain");
      if (
        typeof block?.number !== "bigint"
        || typeof block?.timestamp !== "bigint"
        || typeof block?.hash !== "string"
        || !BLOCK_HASH.test(block.hash)
      ) {
        throw new Error("malformed finalized head");
      }
      return {
        client,
        origin: entry?.origin,
        number: block.number,
        timestamp: block.timestamp,
        hash: block.hash.toLowerCase(),
      };
    }),
  );
  const healthy = observed
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (healthy.length < required) {
    return blocked(
      "finality-quorum-unavailable",
      `only ${healthy.length}/${required} RPC origins returned a valid finalized head`,
    );
  }
  const fresh = healthy.filter((head) => {
    const age = BigInt(nowSeconds) - head.timestamp;
    return age <= BigInt(maxAge) && age >= -BigInt(maxFutureSkew);
  });
  if (fresh.length < required) {
    return blocked(
      "finality-quorum-stale",
      `only ${fresh.length}/${required} RPC origins report a recent finalized head`,
    );
  }

  const highest = fresh.reduce(
    (current, head) => (head.number > current ? head.number : current),
    fresh[0].number,
  );
  const nearHead = fresh.filter((head) => highest - head.number <= BigInt(maxHeadSkew));
  if (nearHead.length < required) {
    return blocked(
      "finality-head-skew",
      `only ${nearHead.length}/${required} RPC origins are within ${maxHeadSkew} finalized blocks`,
    );
  }
  const anchor = nearHead.reduce(
    (current, head) => (head.number < current ? head.number : current),
    nearHead[0].number,
  );
  const reads = await Promise.allSettled(
    nearHead.map(async (head) => {
      const block = head.number === anchor
        ? { number: head.number, hash: head.hash, timestamp: head.timestamp }
        : await head.client.getBlock({ blockNumber: anchor });
      if (
        typeof block?.number !== "bigint"
        || block.number !== anchor
        || typeof block?.timestamp !== "bigint"
        || typeof block?.hash !== "string"
        || !BLOCK_HASH.test(block.hash)
      ) {
        throw new Error("malformed finalized anchor");
      }
      return {
        client: head.client,
        origin: head.origin,
        number: anchor,
        hash: block.hash.toLowerCase(),
        timestamp: block.timestamp,
      };
    }),
  );
  const groups = new Map();
  for (const result of reads) {
    if (result.status !== "fulfilled") continue;
    const group = groups.get(result.value.hash) ?? [];
    group.push(result.value);
    groups.set(result.value.hash, group);
  }
  const agreement = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!agreement || agreement[1].length < required) {
    return blocked(
      "finality-quorum-disagrees",
      `fewer than ${required} RPC origins agree on finalized block ${anchor}`,
    );
  }
  return {
    allowed: true,
    outcome: "finality-quorum-ready",
    detail: `${agreement[1].length} RPC origins agree on finalized block ${anchor}`,
    block: {
      number: anchor,
      hash: agreement[0],
      timestamp: agreement[1][0].timestamp,
    },
    agreeingOrigins: agreement[1].length,
    agreeingClients: agreement[1].map(({ client, origin }) => ({ client, origin })),
  };
}

/**
 * Bind one queued transaction receipt to the same independent RPC quorum that attested the
 * finalized L2 head. A self-consistent receipt and block returned by the primary read client is not
 * sufficient: every agreeing client here must attest the exact transaction, block and outcome.
 */
export async function checkFinalizedReceiptQuorum({
  clients,
  chainId,
  minimumAgreement = 2,
  transactionHash,
  blockNumber,
  blockHash,
  status,
}) {
  const required = Math.max(2, positiveInteger(minimumAgreement, 2));
  const configured = Array.isArray(clients) ? clients : [];
  if (configured.length < required) {
    return blocked(
      "finality-receipt-quorum-unavailable",
      `receipt finality needs ${required} independent RPC origins; ${configured.length} configured`,
    );
  }
  if (
    typeof blockNumber !== "bigint"
    || typeof blockHash !== "string"
    || !BLOCK_HASH.test(blockHash)
    || typeof transactionHash !== "string"
    || !BLOCK_HASH.test(transactionHash)
  ) {
    return blocked("finality-receipt-invalid", "queued receipt identity is malformed");
  }

  const expectedBlockHash = blockHash.toLowerCase();
  const expectedTransactionHash = transactionHash.toLowerCase();
  const observed = await Promise.allSettled(
    configured.map(async (entry) => {
      const client = entry?.client ?? entry;
      const [observedChainId, block, receipt] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockNumber }),
        client.getTransactionReceipt({ hash: transactionHash }),
      ]);
      if (Number(observedChainId) !== Number(chainId)) throw new Error("wrong chain");
      if (
        typeof block?.number !== "bigint"
        || block.number !== blockNumber
        || typeof block?.hash !== "string"
        || block.hash.toLowerCase() !== expectedBlockHash
      ) {
        throw new Error("receipt block is not canonical");
      }
      if (
        typeof receipt?.blockNumber !== "bigint"
        || receipt.blockNumber !== blockNumber
        || typeof receipt?.blockHash !== "string"
        || receipt.blockHash.toLowerCase() !== expectedBlockHash
        || typeof receipt?.transactionHash !== "string"
        || receipt.transactionHash.toLowerCase() !== expectedTransactionHash
        || receipt.status !== status
      ) {
        throw new Error("transaction receipt does not match");
      }
      return true;
    }),
  );
  const agreeing = observed.filter((result) => result.status === "fulfilled").length;
  if (agreeing < required) {
    return blocked(
      "finality-receipt-quorum-disagrees",
      `only ${agreeing}/${required} finalized RPC origins attest the exact transaction receipt`,
    );
  }
  return {
    allowed: true,
    outcome: "finality-receipt-quorum-ready",
    detail: `${agreeing} RPC origins attest the exact finalized transaction receipt`,
    agreeingOrigins: agreeing,
  };
}

/**
 * Require independent nodes to agree on one recent canonical block, then optionally require the
 * same state-changing call to simulate successfully on that exact block through the quorum.
 *
 * Client/endpoint errors are intentionally reduced to counts. Provider URLs can contain API
 * credentials and viem error strings can repeat them.
 */
export async function checkLateBlockQuorum({
  clients,
  chainId,
  minimumAgreement = 2,
  maxHeadSkewBlocks = 2,
  maxBlockAgeSeconds = 60,
  maxFutureSkewSeconds = 30,
  nowSeconds = Math.floor(Date.now() / 1_000),
  simulate,
}) {
  const required = Math.max(2, positiveInteger(minimumAgreement, 2));
  const maxHeadSkew = nonNegativeInteger(maxHeadSkewBlocks, 2);
  const maxAge = positiveInteger(maxBlockAgeSeconds, 60);
  const maxFutureSkew = nonNegativeInteger(maxFutureSkewSeconds, 30);
  const configured = Array.isArray(clients) ? clients : [];
  if (configured.length < required) {
    return blocked(
      "late-block-quorum-unavailable",
      `late-block admission needs ${required} independent RPC origins; ${configured.length} configured`,
    );
  }

  const observed = await Promise.allSettled(
    configured.map(async (entry, index) => {
      const client = entry?.client ?? entry;
      const [observedChainId, block] = await Promise.all([
        client.getChainId(),
        client.getBlock({ blockTag: "latest" }),
      ]);
      if (Number(observedChainId) !== Number(chainId)) throw new Error("wrong chain");
      if (
        typeof block?.number !== "bigint"
        || typeof block?.timestamp !== "bigint"
        || typeof block?.hash !== "string"
        || !BLOCK_HASH.test(block.hash)
      ) {
        throw new Error("malformed head");
      }
      return {
        client,
        index,
        number: block.number,
        timestamp: block.timestamp,
        hash: block.hash.toLowerCase(),
      };
    }),
  );
  const healthy = observed
    .filter((result) => result.status === "fulfilled")
    .map((result) => result.value);
  if (healthy.length < required) {
    return blocked(
      "late-block-quorum-unavailable",
      `only ${healthy.length}/${required} independent RPC origins returned a valid chain head`,
    );
  }

  const fresh = healthy.filter((head) => {
    const age = BigInt(nowSeconds) - head.timestamp;
    return age <= BigInt(maxAge) && age >= -BigInt(maxFutureSkew);
  });
  if (fresh.length < required) {
    return blocked(
      "sequencer-stale",
      `only ${fresh.length}/${required} RPC origins report a recent chain head; execution is paused`,
    );
  }

  const highest = fresh.reduce(
    (current, head) => (head.number > current ? head.number : current),
    fresh[0].number,
  );
  const nearHead = fresh.filter((head) => highest - head.number <= BigInt(maxHeadSkew));
  if (nearHead.length < required) {
    return blocked(
      "late-block-head-skew",
      `only ${nearHead.length}/${required} RPC origins are within ${maxHeadSkew} blocks of the freshest head`,
    );
  }
  const anchor = nearHead.reduce(
    (current, head) => (head.number < current ? head.number : current),
    nearHead[0].number,
  );

  const canonicalReads = await Promise.allSettled(
    nearHead.map(async (head) => {
      const block = head.number === anchor
        ? { number: head.number, hash: head.hash }
        : await head.client.getBlock({ blockNumber: anchor });
      if (
        typeof block?.number !== "bigint"
        || block.number !== anchor
        || typeof block?.hash !== "string"
        || !BLOCK_HASH.test(block.hash)
      ) {
        throw new Error("malformed canonical block");
      }
      return { ...head, anchorHash: block.hash.toLowerCase() };
    }),
  );
  const groups = new Map();
  for (const result of canonicalReads) {
    if (result.status !== "fulfilled") continue;
    const group = groups.get(result.value.anchorHash) ?? [];
    group.push(result.value);
    groups.set(result.value.anchorHash, group);
  }
  const agreement = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0];
  if (!agreement || agreement[1].length < required) {
    return blocked(
      "late-block-quorum-disagrees",
      `fewer than ${required} RPC origins agree on the canonical block at height ${anchor}`,
    );
  }

  if (typeof simulate === "function") {
    const simulations = await Promise.allSettled(
      agreement[1].map(async ({ client }) => {
        const result = await simulate(client, anchor);
        const block = await client.getBlock({ blockNumber: anchor });
        if (
          typeof block?.number !== "bigint"
          || block.number !== anchor
          || typeof block?.hash !== "string"
          || block.hash.toLowerCase() !== agreement[0]
        ) {
          throw new Error("canonical anchor changed during simulation");
        }
        return result;
      }),
    );
    const resultGroups = new Map();
    for (const result of simulations) {
      if (result.status !== "fulfilled") continue;
      const fingerprint = simulationFingerprint(result.value);
      resultGroups.set(fingerprint, (resultGroups.get(fingerprint) ?? 0) + 1);
    }
    const matching = Math.max(0, ...resultGroups.values());
    if (matching < required) {
      return blocked(
        "late-block-simulation-failed",
        `only ${matching}/${required} agreeing RPC origins returned the same successful simulation`,
      );
    }
  }

  return {
    allowed: true,
    outcome: "late-block-quorum-ready",
    detail:
      `${agreement[1].length} RPC origins agree on recent block ${anchor} `
      + `${agreement[0].slice(0, 10)}…`,
    blockNumber: anchor,
    blockHash: agreement[0],
    agreeingOrigins: agreement[1].length,
  };
}
