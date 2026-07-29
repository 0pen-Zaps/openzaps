import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createPublicClient,
  getAddress,
  http,
  isHash,
  keccak256,
  toBytes,
} from "viem";
import { parsePreparedCanaryManifest } from "./lib/canary-prepared-manifest.mjs";
import {
  parseDeploymentVerificationEvidence,
} from "./lib/canary-reviewed-plan.mjs";
import { verifyReleaseCheckout } from "./lib/release-checkout.mjs";
import {
  assertSafeStateMatches,
  readSafeStateAtBlock,
  validateSafeDeploymentEvidence,
} from "./lib/safe-deployment-evidence.mjs";
import {
  assertCanonicalReleaseSnapshot,
  assertDeploymentEvidenceBinding,
  assertDeploymentEvidenceReadback,
  assertPreparedSafeTransactionHashes,
  RELEASE_FACTORY_ABI,
  RELEASE_LAUNCHPAD_ABI,
  RELEASE_VAULT_ABI,
  SAFE_TRANSACTION_HASH_ABI,
  serializeSafeClaim,
} from "./lib/safe-canary-pre-sign.mjs";

const ZERO_HASH = `0x${"0".repeat(64)}`;

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredNonzeroHash(name) {
  const value = requiredEnv(name);
  if (!isHash(value) || value.toLowerCase() === ZERO_HASH) {
    throw new Error(`${name} must be a nonzero hash`);
  }
  return value.toLowerCase();
}

async function rpcCall(label, operation) {
  try {
    return await operation();
  } catch {
    throw new Error(`RPC request failed while reading ${label}`);
  }
}

function sameAddress(left, right) {
  return getAddress(left) === getAddress(right);
}

async function readLaunchpadSnapshot(client, launchpad, blockNumber) {
  const [protocolTreasury, tokenFactory, feeVaultFactory, positionManager] =
    await Promise.all(
      [
        "protocolTreasury",
        "tokenFactory",
        "feeVaultFactory",
        "positionManager",
      ].map((functionName) =>
        client.readContract({
          address: launchpad,
          abi: RELEASE_LAUNCHPAD_ABI,
          functionName,
          blockNumber,
        }),
      ),
    );
  return {
    protocolTreasury,
    tokenFactory,
    feeVaultFactory,
    positionManager,
  };
}

async function readFactorySnapshot(client, address, blockNumber) {
  const [code, launchpad] = await Promise.all([
    client.getCode({ address, blockNumber }),
    client.readContract({
      address,
      abi: RELEASE_FACTORY_ABI,
      functionName: "launchpad",
      blockNumber,
    }),
  ]);
  return { address, code, launchpad };
}

async function readCanarySnapshot(
  client,
  launchpad,
  prepared,
  label,
  blockNumber,
) {
  const canary = prepared.canaries[label];
  const [
    launch,
    tokenCode,
    poolCode,
    vaultCode,
    vaultLaunchpad,
    launchToken,
    pairedAsset,
    positionManager,
    positionId,
    totalSupply,
    safeShares,
    creatorShares,
    safeTokenClaimable,
    safePairClaimable,
  ] = await Promise.all([
    client.readContract({
      address: launchpad,
      abi: RELEASE_LAUNCHPAD_ABI,
      functionName: "launches",
      args: [canary.token],
      blockNumber,
    }),
    client.getCode({ address: canary.token, blockNumber }),
    client.getCode({ address: canary.pool, blockNumber }),
    client.getCode({ address: canary.vault, blockNumber }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "launchpad",
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "launchToken",
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "pairedAsset",
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "positionManager",
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "positionId",
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "totalSupply",
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "balanceOf",
      args: [prepared.safe],
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "balanceOf",
      args: [prepared.creator],
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "claimable",
      args: [prepared.safe, canary.token],
      blockNumber,
    }),
    client.readContract({
      address: canary.vault,
      abi: RELEASE_VAULT_ABI,
      functionName: "claimable",
      args: [prepared.safe, canary.pair],
      blockNumber,
    }),
  ]);
  const [
    exists,
    creator,
    pool,
    feeVault,
    launchPositionId,
    launchPair,
    feeTier,
    floorTick,
  ] = launch;
  return {
    token: canary.token,
    tokenCode,
    poolCode,
    vaultCode,
    launch: {
      exists,
      creator,
      pool,
      feeVault,
      positionId: launchPositionId,
      pairedAsset: launchPair,
      feeTier,
      floorTick,
    },
    vault: {
      launchpad: vaultLaunchpad,
      launchToken,
      pairedAsset,
      positionManager,
      positionId,
      totalSupply,
      safeShares,
      creatorShares,
      safeTokenClaimable,
      safePairClaimable,
    },
  };
}

async function main() {
  const releaseCommit = requiredEnv("EXPECTED_RELEASE_COMMIT");
  await verifyReleaseCheckout(releaseCommit);

  const preparedRaw = await readFile(
    resolve(requiredEnv("CANARY_PREPARED_MANIFEST")),
    "utf8",
  );
  const expectedSafeEvidenceHash = requiredNonzeroHash(
    "SAFE_DEPLOYMENT_EVIDENCE_HASH",
  );
  const prepared = parsePreparedCanaryManifest(preparedRaw, {
    expectedHash: requiredEnv("EXPECTED_CANARY_PREPARED_MANIFEST_HASH"),
    expectedReleaseCommit: releaseCommit,
    expectedSafeDeploymentEvidenceHash: expectedSafeEvidenceHash,
  });
  const expectedDeploymentEvidenceHash = requiredNonzeroHash(
    "EXPECTED_DEPLOYMENT_VERIFICATION_EVIDENCE_HASH",
  );
  const deploymentEvidenceRaw = await readFile(
    resolve(requiredEnv("DEPLOYMENT_VERIFICATION_EVIDENCE")),
    "utf8",
  );
  const deploymentEvidence = parseDeploymentVerificationEvidence(
    deploymentEvidenceRaw,
    {
      expectedHash: expectedDeploymentEvidenceHash,
      expectedReleaseCommit: releaseCommit,
    },
  );
  assertDeploymentEvidenceBinding(prepared, deploymentEvidence);

  const safeEvidenceRaw = await readFile(
    resolve(requiredEnv("SAFE_DEPLOYMENT_EVIDENCE")),
    "utf8",
  );
  if (keccak256(toBytes(safeEvidenceRaw)).toLowerCase() !== expectedSafeEvidenceHash) {
    throw new Error(
      "Safe deployment evidence hash does not match its approval",
    );
  }
  let safeEvidenceJson;
  try {
    safeEvidenceJson = JSON.parse(safeEvidenceRaw);
  } catch {
    throw new Error("Safe deployment evidence is not valid JSON");
  }
  const safeEvidence = validateSafeDeploymentEvidence(
    safeEvidenceJson,
    releaseCommit,
  );
  if (!sameAddress(safeEvidence.config.safe, prepared.safe)) {
    throw new Error("Prepared Safe does not match Safe deployment evidence");
  }
  if (!sameAddress(safeEvidence.config.safe, deploymentEvidence.protocolTreasury)) {
    throw new Error(
      "Safe deployment and stack deployment evidence identify different Safes",
    );
  }

  const rpcUrl = requiredEnv("ROBINHOOD_RPC_URL");
  if (new URL(rpcUrl).protocol !== "https:") {
    throw new Error("ROBINHOOD_RPC_URL must use HTTPS");
  }
  const client = createPublicClient({ transport: http(rpcUrl) });
  const [chainId, checkedBlock] = await Promise.all([
    rpcCall("chain id", () => client.getChainId()),
    rpcCall("head block", () => client.getBlock()),
  ]);
  if (chainId !== 4663 || checkedBlock.number == null || !checkedBlock.hash) {
    throw new Error("Unable to establish a chain-4663 pre-sign block");
  }
  if (
    checkedBlock.number < prepared.observedAtBlock ||
    checkedBlock.number < deploymentEvidence.checkedAtBlock
  ) {
    throw new Error("Pre-sign block predates reviewed release evidence");
  }

  const [
    safeState,
    deploymentEvidenceBlock,
    launchpadCodeAtEvidence,
    launchpadCodeCurrent,
    launchpadSnapshot,
    wethCanary,
    usdgCanary,
    wethHash,
    usdgHash,
  ] = await Promise.all([
    rpcCall("current Safe state", () =>
      readSafeStateAtBlock(client, prepared.safe, checkedBlock.number),
    ),
    rpcCall("deployment evidence block", () =>
      client.getBlock({ blockNumber: deploymentEvidence.checkedAtBlock }),
    ),
    rpcCall("deployment-evidence launchpad code", () =>
      client.getCode({
        address: prepared.launchpad,
        blockNumber: deploymentEvidence.checkedAtBlock,
      }),
    ),
    rpcCall("current launchpad code", () =>
      client.getCode({
        address: prepared.launchpad,
        blockNumber: checkedBlock.number,
      }),
    ),
    rpcCall("current launchpad identity", () =>
      readLaunchpadSnapshot(
        client,
        prepared.launchpad,
        checkedBlock.number,
      ),
    ),
    rpcCall("current WETH canary state", () =>
      readCanarySnapshot(
        client,
        prepared.launchpad,
        prepared,
        "weth",
        checkedBlock.number,
      ),
    ),
    rpcCall("current USDG canary state", () =>
      readCanarySnapshot(
        client,
        prepared.launchpad,
        prepared,
        "usdg",
        checkedBlock.number,
      ),
    ),
    rpcCall("WETH Safe transaction hash", () =>
      client.readContract({
        address: prepared.safe,
        abi: SAFE_TRANSACTION_HASH_ABI,
        functionName: "getTransactionHash",
        args: [
          prepared.claims.weth.target,
          prepared.claims.weth.value,
          prepared.claims.weth.data,
          prepared.claims.weth.operation,
          prepared.claims.weth.safeTxGas,
          prepared.claims.weth.baseGas,
          prepared.claims.weth.gasPrice,
          prepared.claims.weth.gasToken,
          prepared.claims.weth.refundReceiver,
          prepared.claims.weth.nonce,
        ],
        blockNumber: checkedBlock.number,
      }),
    ),
    rpcCall("USDG Safe transaction hash", () =>
      client.readContract({
        address: prepared.safe,
        abi: SAFE_TRANSACTION_HASH_ABI,
        functionName: "getTransactionHash",
        args: [
          prepared.claims.usdg.target,
          prepared.claims.usdg.value,
          prepared.claims.usdg.data,
          prepared.claims.usdg.operation,
          prepared.claims.usdg.safeTxGas,
          prepared.claims.usdg.baseGas,
          prepared.claims.usdg.gasPrice,
          prepared.claims.usdg.gasToken,
          prepared.claims.usdg.refundReceiver,
          prepared.claims.usdg.nonce,
        ],
        blockNumber: checkedBlock.number,
      }),
    ),
  ]);
  if (!deploymentEvidenceBlock.hash) {
    throw new Error("Deployment evidence block has no hash");
  }
  assertDeploymentEvidenceReadback(deploymentEvidence, {
    evidenceBlockHash: deploymentEvidenceBlock.hash,
    launchpadCodeAtEvidence,
    launchpadCodeCurrent,
  });
  assertSafeStateMatches(
    safeState,
    safeEvidence.config,
    safeEvidence.runtimeCodeHash,
  );
  if (safeState.nonce !== prepared.startingSafeNonce) {
    throw new Error("Prepared Safe nonce is no longer current");
  }
  const [tokenFactory, feeVaultFactory] = await Promise.all([
    rpcCall("current token factory state", () =>
      readFactorySnapshot(
        client,
        launchpadSnapshot.tokenFactory,
        checkedBlock.number,
      ),
    ),
    rpcCall("current fee-vault factory state", () =>
      readFactorySnapshot(
        client,
        launchpadSnapshot.feeVaultFactory,
        checkedBlock.number,
      ),
    ),
  ]);
  assertCanonicalReleaseSnapshot(prepared, deploymentEvidence, {
    launchpad: launchpadSnapshot,
    factories: {
      token: tokenFactory,
      feeVault: feeVaultFactory,
    },
    canaries: {
      weth: wethCanary,
      usdg: usdgCanary,
    },
  });
  assertPreparedSafeTransactionHashes(prepared, {
    weth: wethHash,
    usdg: usdgHash,
  });

  const blockReadback = await rpcCall("pre-sign block readback", () =>
    client.getBlock({ blockNumber: checkedBlock.number }),
  );
  if (
    !blockReadback.hash ||
    blockReadback.hash.toLowerCase() !== checkedBlock.hash.toLowerCase()
  ) {
    throw new Error("Pre-sign verification block changed during readback");
  }

  const evidence = {
    ok: true,
    kind: "zappad-safe-canary-pre-sign",
    schemaVersion: 1,
    chainId,
    releaseCommit: releaseCommit.toLowerCase(),
    checkedAtBlock: checkedBlock.number.toString(),
    checkedAtBlockHash: checkedBlock.hash,
    preparedManifestHash: prepared.hash,
    safeDeploymentEvidenceHash: expectedSafeEvidenceHash,
    deploymentVerificationEvidenceHash: expectedDeploymentEvidenceHash,
    launchpad: prepared.launchpad,
    safe: prepared.safe,
    currentNonce: safeState.nonce.toString(),
    factories: {
      tokenFactory: launchpadSnapshot.tokenFactory,
      feeVaultFactory: launchpadSnapshot.feeVaultFactory,
    },
    canaries: {
      weth: {
        token: prepared.canaries.weth.token,
        vault: prepared.canaries.weth.vault,
        pool: prepared.canaries.weth.pool,
        positionId: prepared.canaries.weth.positionId.toString(),
        safeTokenClaimable: prepared.claims.weth.expectedToken.toString(),
        safePairClaimable: prepared.claims.weth.expectedPair.toString(),
      },
      usdg: {
        token: prepared.canaries.usdg.token,
        vault: prepared.canaries.usdg.vault,
        pool: prepared.canaries.usdg.pool,
        positionId: prepared.canaries.usdg.positionId.toString(),
        safeTokenClaimable: prepared.claims.usdg.expectedToken.toString(),
        safePairClaimable: prepared.claims.usdg.expectedPair.toString(),
      },
    },
    transactions: [
      serializeSafeClaim("weth", prepared.claims.weth),
      serializeSafeClaim("usdg", prepared.claims.usdg),
    ],
    submissionPerformed: false,
  };
  const json = `${JSON.stringify(evidence, null, 2)}\n`;
  if (process.env.CANARY_SAFE_PRE_SIGN_EVIDENCE) {
    await writeFile(resolve(process.env.CANARY_SAFE_PRE_SIGN_EVIDENCE), json, {
      flag: "wx",
    });
  }
  process.stdout.write(json);
}

main().catch((error) => {
  const rpcUrl = process.env.ROBINHOOD_RPC_URL;
  const raw = error instanceof Error ? error.message : String(error);
  const message = rpcUrl ? raw.split(rpcUrl).join("[redacted RPC]") : raw;
  console.error(message);
  process.exitCode = 1;
});
