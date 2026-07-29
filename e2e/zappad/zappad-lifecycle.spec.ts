import type { Download, Page } from "@playwright/test";
import {
  getAddress,
  parseEther,
  parseUnits,
  type Address,
} from "viem";
import { expect, test, type WalletHarness } from "./fixtures/zappad";
import {
  approveToken,
  readAllowance,
  readAssetState,
  readClaimables,
  readLaunch,
  readPositionOwner,
  readTokenBalance,
  readVaultShares,
  readVaultSupply,
  sellTokenForWeth,
  transferToken,
} from "./support/chain";
import type { ZapPadE2eRunState } from "./support/run-state";

interface LaunchReceipt {
  schema: string;
  chainId: number;
  launcher: Address;
  transactionHash: `0x${string}`;
  creator: Address;
  protocolTreasury: Address;
  token: Address;
  feeVault: Address;
  pool: Address;
  positionId: string;
  launch: {
    pairedAsset: Address;
    feeTier: number;
    nativeValue: string;
  };
}

const SHARE_SUPPLY = parseUnits("100", 18);

async function downloadJson(download: Download) {
  const stream = await download.createReadStream();
  if (!stream) throw new Error("Playwright did not expose the receipt download.");
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as LaunchReceipt;
}

function transactionRequests(wallet: WalletHarness) {
  return wallet
    .requests()
    .filter((request) => request.method === "eth_sendTransaction")
    .map((request) => request.params[0] as Record<string, unknown>);
}

function difference(left: bigint, right: bigint) {
  return left >= right ? left - right : right - left;
}

function expectShare(actual: bigint, batch: bigint, shares: bigint) {
  const expected = (batch * shares) / SHARE_SUPPLY;
  expect(difference(actual, expected)).toBeLessThanOrEqual(2n);
}

async function waitForClaimables(
  state: ZapPadE2eRunState,
  vault: Address,
  holder: Address,
  predicate: (amounts: readonly bigint[]) => boolean,
) {
  await expect
    .poll(async () => {
      const snapshot = await readClaimables(state, vault, holder);
      return predicate(snapshot.amounts);
    })
    .toBe(true);
}

async function claimThroughBrowser(
  page: Page,
  wallet: WalletHarness,
  state: ZapPadE2eRunState,
  vault: Address,
  account: Address,
) {
  await wallet.setAccount(account);
  const claim = page.getByRole("button", { name: "Claim all" });
  await expect(claim).toBeEnabled();
  await claim.click();
  await expect(
    page.getByText("Available fees were claimed to your wallet."),
  ).toBeVisible();
  await expect(page.locator(".vault-panel")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await waitForClaimables(
    state,
    vault,
    account,
    (amounts) => amounts.every((amount) => amount === 0n),
  );
}

async function completeLaunchForm(
  page: Page,
  values: {
    name: string;
    symbol: string;
    metadata: string;
    firstBuy: string;
    minimumOut: string;
    pair?: "WETH" | "USDG";
  },
) {
  await page.getByLabel("Token name").fill(values.name);
  await page.getByLabel("Symbol").fill(values.symbol);
  await page.getByLabel("Metadata URI").fill(values.metadata);
  if (values.pair === "USDG") {
    await page
      .locator(".pair-choices")
      .getByRole("button", { name: /USDG/ })
      .click();
  }
  await page.getByLabel("Optional first buy").fill(values.firstBuy);
  await page.getByLabel("Minimum tokens out").fill(values.minimumOut);
  await expect(page.getByText(/Verified token0 ordering/)).toBeVisible({
    timeout: 30_000,
  });
}

test("fresh Robinhood fork completes WETH fee-right lifecycle and USDG launch", async ({
  page,
  runState,
  wallet,
}) => {
  test.slow();

  const wethName = "ZapPad Browser Canary";
  const wethSymbol = "ZPBC";
  let wethReceipt!: LaunchReceipt;
  let runtimeWritesPaused = false;

  await page.route("**/api/launch/config", async (route) => {
    const response = await route.fetch();
    if (!runtimeWritesPaused) {
      await route.fulfill({ response });
      return;
    }
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...body, launchEnabled: false },
    });
  });

  await test.step("connect injected loopback wallet and reject impossible minimum without a write", async () => {
    await page.goto("/launch");
    await expect(page.getByText("Writes enabled")).toBeVisible();

    await page
      .locator(".review-card")
      .getByRole("button", { name: "Connect wallet", exact: true })
      .click();

    await expect
      .poll(() => wallet.count("eth_requestAccounts"))
      .toBeGreaterThan(0);
    await expect
      .poll(() => wallet.count("wallet_switchEthereumChain"))
      .toBeGreaterThan(0);

    await completeLaunchForm(page, {
      name: wethName,
      symbol: wethSymbol,
      metadata: "ipfs://bafyzappadbrowsercanary/metadata.json",
      firstBuy: "0.001",
      minimumOut: "1000000000",
    });

    const writesBeforeFailure = wallet.count("eth_sendTransaction");
    await page.getByRole("button", { name: "Run exact simulation" }).click();
    await expect(page.locator(".review-card .notice-danger")).toBeVisible();
    expect(wallet.count("eth_sendTransaction")).toBe(writesBeforeFailure);
  });

  await test.step("simulate exact WETH call, launch, verify receipt and download evidence", async () => {
    await page.getByLabel("Minimum tokens out").fill("1");
    await page.getByRole("button", { name: "Run exact simulation" }).click();
    await expect(page.getByText("Exact call simulated")).toBeVisible();

    runtimeWritesPaused = true;
    const writesBeforePausedRuntime = wallet.count("eth_sendTransaction");
    await page
      .getByRole("button", { name: /Launch on Robinhood Chain/ })
      .click();
    await expect(
      page.getByText(/launch writes were disabled/i),
    ).toBeVisible();
    expect(wallet.count("eth_sendTransaction")).toBe(
      writesBeforePausedRuntime,
    );

    runtimeWritesPaused = false;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByText("Writes enabled")).toBeVisible();
    await page.getByRole("button", { name: "Run exact simulation" }).click();
    await expect(page.getByText("Exact call simulated")).toBeVisible();

    const writesBeforeLaunch = wallet.count("eth_sendTransaction");
    await page
      .getByRole("button", { name: /Launch on Robinhood Chain/ })
      .click();
    await expect(
      page.getByRole("heading", {
        name: `${wethName} $${wethSymbol} is live.`,
      }),
    ).toBeVisible({ timeout: 60_000 });
    expect(wallet.count("eth_sendTransaction")).toBe(writesBeforeLaunch + 1);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download receipt" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(
      /^zappad-zpbc-[0-9a-f]{8}\.json$/i,
    );
    wethReceipt = await downloadJson(download);

    expect(wethReceipt.schema).toBe("zappad-launch-receipt/v1");
    expect(wethReceipt.chainId).toBe(runState.chainId);
    expect(getAddress(wethReceipt.launcher)).toBe(runState.launcher);
    expect(getAddress(wethReceipt.creator)).toBe(runState.accounts.creator);
    expect(getAddress(wethReceipt.protocolTreasury)).toBe(
      runState.accounts.treasury,
    );
    expect(getAddress(wethReceipt.launch.pairedAsset)).toBe(
      runState.contracts.weth,
    );
    expect(BigInt(wethReceipt.launch.nativeValue)).toBe(parseEther("0.001"));

    const launchTransactions = transactionRequests(wallet).filter(
      (transaction) =>
        String(transaction.to).toLowerCase() ===
        runState.launcher.toLowerCase(),
    );
    expect(launchTransactions).toHaveLength(1);
    expect(BigInt(String(launchTransactions[0].value ?? "0x0"))).toBe(
      parseEther("0.001"),
    );
  });

  const wethToken = getAddress(wethReceipt.token);
  const wethVault = getAddress(wethReceipt.feeVault);
  const wethPosition = BigInt(wethReceipt.positionId);
  const revenueAssets = [wethToken, runState.contracts.weth] as const;

  await test.step("read the launch through token, Explore and Portfolio surfaces", async () => {
    await page.getByRole("link", { name: "Open token console" }).click();
    await expect(page).toHaveURL(
      new RegExp(`/launch/token/${wethToken}$`, "i"),
    );
    await expect(page.getByRole("heading", { name: wethName })).toBeVisible();
    await expect(page.getByText("Claim the cash flow.")).toBeVisible();

    const launch = await readLaunch(runState, wethToken);
    expect(launch.exists).toBe(true);
    expect(launch.creator).toBe(runState.accounts.creator);
    expect(launch.feeVault).toBe(wethVault);
    expect(launch.positionId).toBe(wethPosition);

    await page.goto("/launch/explore");
    await page
      .getByPlaceholder("Search name, symbol or address")
      .fill(wethSymbol);
    const card = page.locator(".launch-card").filter({ hasText: wethName });
    await expect(card).toBeVisible();
    await card.getByRole("link", { name: /Open token console/ }).click();
    await expect(page.getByRole("heading", { name: wethName })).toBeVisible();

    await page.goto("/launch/portfolio");
    await expect(page.getByText(wethName).first()).toBeVisible();
    await expect(page.getByRole("link", { name: /Manage fees/ })).toBeVisible();
    await page.getByRole("link", { name: /Manage fees/ }).click();
    await expect(page.getByRole("heading", { name: wethName })).toBeVisible();
  });

  const firstStateBefore = await Promise.all(
    revenueAssets.map((asset) => readAssetState(runState, wethVault, asset)),
  );

  await test.step("harvest first-buy fees and preserve the initial 80/20 entitlement", async () => {
    await page.getByRole("button", { name: "Harvest pool fees" }).click();
    await expect(
      page.getByText("Pool fees were harvested into the vault."),
    ).toBeVisible();

    const [creatorClaims, treasuryClaims, recipientClaims] = await Promise.all([
      readClaimables(runState, wethVault, runState.accounts.creator),
      readClaimables(runState, wethVault, runState.accounts.treasury),
      readClaimables(runState, wethVault, runState.accounts.recipient),
    ]);
    const firstStateAfter = await Promise.all(
      revenueAssets.map((asset) => readAssetState(runState, wethVault, asset)),
    );
    const batches = firstStateAfter.map(
      (state, index) => state.totalSynced - firstStateBefore[index].totalSynced,
    );
    expect(batches.some((batch) => batch > 0n)).toBe(true);
    for (let index = 0; index < batches.length; index += 1) {
      expectShare(creatorClaims.amounts[index], batches[index], parseUnits("80", 18));
      expectShare(treasuryClaims.amounts[index], batches[index], parseUnits("20", 18));
      expect(recipientClaims.amounts[index]).toBe(0n);
    }

    await claimThroughBrowser(
      page,
      wallet,
      runState,
      wethVault,
      runState.accounts.creator,
    );
    const treasuryPreserved = await readClaimables(
      runState,
      wethVault,
      runState.accounts.treasury,
    );
    expect(treasuryPreserved.amounts.some((amount) => amount > 0n)).toBe(true);
  });

  await test.step("transfer ten fee shares, execute an external reverse swap, and harvest 70/20/10", async () => {
    await page.getByLabel("Recipient address").fill(runState.accounts.recipient);
    await page.getByLabel("Fee shares").fill("10");
    await page.getByRole("button", { name: "Transfer shares" }).click();

    await expect
      .poll(() =>
        readVaultShares(
          runState,
          wethVault,
          runState.accounts.recipient,
        ),
      )
      .toBe(parseUnits("10", 18));
    expect(
      await readVaultShares(runState, wethVault, runState.accounts.creator),
    ).toBe(parseUnits("70", 18));
    expect(
      await readVaultShares(runState, wethVault, runState.accounts.treasury),
    ).toBe(parseUnits("20", 18));

    const creatorTokenBalance = await readTokenBalance(
      runState,
      wethToken,
      runState.accounts.creator,
    );
    const sellAmount = creatorTokenBalance / 4n;
    expect(sellAmount).toBeGreaterThan(0n);
    await transferToken(
      runState,
      wethToken,
      runState.accounts.creator,
      runState.accounts.trader,
      sellAmount,
    );
    const swap = await sellTokenForWeth(
      runState,
      wethToken,
      runState.accounts.trader,
      sellAmount,
      wethReceipt.launch.feeTier,
    );
    expect(swap.amountOut).toBeGreaterThan(0n);
    expect(
      await readAllowance(
        runState,
        wethToken,
        runState.accounts.trader,
        runState.contracts.swapRouter,
      ),
    ).toBe(0n);

    const beforeClaims = await Promise.all([
      readClaimables(runState, wethVault, runState.accounts.creator),
      readClaimables(runState, wethVault, runState.accounts.treasury),
      readClaimables(runState, wethVault, runState.accounts.recipient),
    ]);
    const beforeStates = await Promise.all(
      revenueAssets.map((asset) => readAssetState(runState, wethVault, asset)),
    );

    await page.getByRole("button", { name: "Harvest pool fees" }).click();
    await expect(
      page.getByText("Pool fees were harvested into the vault."),
    ).toBeVisible();

    const afterClaims = await Promise.all([
      readClaimables(runState, wethVault, runState.accounts.creator),
      readClaimables(runState, wethVault, runState.accounts.treasury),
      readClaimables(runState, wethVault, runState.accounts.recipient),
    ]);
    const afterStates = await Promise.all(
      revenueAssets.map((asset) => readAssetState(runState, wethVault, asset)),
    );
    const batches = afterStates.map(
      (state, index) => state.totalSynced - beforeStates[index].totalSynced,
    );
    expect(batches[0]).toBeGreaterThan(0n);

    for (let index = 0; index < batches.length; index += 1) {
      expectShare(
        afterClaims[0].amounts[index] - beforeClaims[0].amounts[index],
        batches[index],
        parseUnits("70", 18),
      );
      expectShare(
        afterClaims[1].amounts[index] - beforeClaims[1].amounts[index],
        batches[index],
        parseUnits("20", 18),
      );
      expectShare(
        afterClaims[2].amounts[index] - beforeClaims[2].amounts[index],
        batches[index],
        parseUnits("10", 18),
      );
    }
  });

  await test.step("claim as creator, recipient, and treasury, then prove custody and cleanup invariants", async () => {
    await claimThroughBrowser(
      page,
      wallet,
      runState,
      wethVault,
      runState.accounts.creator,
    );
    await claimThroughBrowser(
      page,
      wallet,
      runState,
      wethVault,
      runState.accounts.recipient,
    );
    await claimThroughBrowser(
      page,
      wallet,
      runState,
      wethVault,
      runState.accounts.treasury,
    );

    for (const holder of Object.values({
      creator: runState.accounts.creator,
      recipient: runState.accounts.recipient,
      treasury: runState.accounts.treasury,
    })) {
      const claimable = await readClaimables(runState, wethVault, holder);
      expect(claimable.amounts.every((amount) => amount === 0n)).toBe(true);
    }

    expect(await readVaultSupply(runState, wethVault)).toBe(SHARE_SUPPLY);
    expect(await readPositionOwner(runState, wethPosition)).toBe(wethVault);
    expect(
      await readAllowance(
        runState,
        wethToken,
        runState.launcher,
        runState.contracts.positionManager,
      ),
    ).toBe(0n);
    expect(
      await readAllowance(
        runState,
        runState.contracts.weth,
        runState.launcher,
        runState.contracts.swapRouter,
      ),
    ).toBe(0n);
    expect(
      await readTokenBalance(runState, wethToken, runState.launcher),
    ).toBe(0n);
    expect(
      await readTokenBalance(
        runState,
        runState.contracts.weth,
        runState.launcher,
      ),
    ).toBe(0n);

    for (const asset of revenueAssets) {
      const state = await readAssetState(runState, wethVault, asset);
      const vaultBalance = await readTokenBalance(runState, asset, wethVault);
      expect(vaultBalance).toBe(state.lastBalance);
      expect(state.totalSynced).toBe(state.totalClaimed + state.lastBalance);
      expect(vaultBalance).toBeLessThanOrEqual(5n);
    }
  });

  await test.step("replace and revoke stale USDG approvals before an exact zero-native launch", async () => {
    await wallet.setAccount(runState.accounts.creator);
    expect(
      await readTokenBalance(
        runState,
        runState.contracts.usdg,
        runState.accounts.creator,
      ),
    ).toBeGreaterThanOrEqual(parseUnits("1", 6));

    await page.goto("/launch");
    await completeLaunchForm(page, {
      name: "ZapPad USDG Browser",
      symbol: "ZUSDG",
      metadata: "ipfs://bafyzappadusdgbrowser/metadata.json",
      firstBuy: "1",
      minimumOut: "1",
      pair: "USDG",
    });

    await page.getByRole("button", { name: "Run exact simulation" }).click();
    await expect(
      page.getByRole("button", { name: "Approve exact first buy" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve exact first buy" }).click();
    await expect(page.getByText("Exact call simulated")).toBeVisible({
      timeout: 30_000,
    });
    expect(
      await readAllowance(
        runState,
        runState.contracts.usdg,
        runState.accounts.creator,
        runState.launcher,
      ),
    ).toBe(parseUnits("1", 6));

    await page.getByLabel("Optional first buy").fill("0.5");
    await page.getByRole("button", { name: "Run exact simulation" }).click();
    await expect(
      page.getByRole("button", { name: "Approve exact first buy" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve exact first buy" }).click();
    await expect(page.getByText("Exact call simulated")).toBeVisible({
      timeout: 30_000,
    });
    expect(
      await readAllowance(
        runState,
        runState.contracts.usdg,
        runState.accounts.creator,
        runState.launcher,
      ),
    ).toBe(parseUnits("0.5", 6));

    await page
      .getByRole("button", { name: "Revoke 0.5 USDG allowance" })
      .click();
    await expect
      .poll(() =>
        readAllowance(
          runState,
          runState.contracts.usdg,
          runState.accounts.creator,
          runState.launcher,
        ),
      )
      .toBe(0n);
    await expect(
      page.getByRole("button", { name: "Approve exact first buy" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve exact first buy" }).click();
    await expect(page.getByText("Exact call simulated")).toBeVisible({
      timeout: 30_000,
    });

    await approveToken(
      runState,
      runState.contracts.usdg,
      runState.accounts.creator,
      runState.launcher,
      parseUnits("1", 6),
    );
    const writesBeforeAllowanceDrift = wallet.count("eth_sendTransaction");
    await page
      .getByRole("button", { name: /Launch on Robinhood Chain/ })
      .click();
    await expect(
      page.getByText(/USDG allowance changed after pre-flight/i),
    ).toBeVisible();
    expect(wallet.count("eth_sendTransaction")).toBe(
      writesBeforeAllowanceDrift,
    );
    await expect(
      page.getByRole("button", { name: "Approve exact first buy" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve exact first buy" }).click();
    await expect(page.getByText("Exact call simulated")).toBeVisible({
      timeout: 30_000,
    });

    await page
      .getByRole("button", { name: /Launch on Robinhood Chain/ })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "ZapPad USDG Browser $ZUSDG is live.",
      }),
    ).toBeVisible({ timeout: 60_000 });

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download receipt" }).click();
    const usdgReceipt = await downloadJson(await downloadPromise);
    const usdgToken = getAddress(usdgReceipt.token);
    expect(getAddress(usdgReceipt.launch.pairedAsset)).toBe(
      runState.contracts.usdg,
    );
    expect(BigInt(usdgReceipt.launch.nativeValue)).toBe(0n);

    const launcherTransactions = transactionRequests(wallet).filter(
      (transaction) =>
        String(transaction.to).toLowerCase() ===
        runState.launcher.toLowerCase(),
    );
    const usdgLaunchTransaction = launcherTransactions.at(-1);
    expect(usdgLaunchTransaction).toBeDefined();
    expect(BigInt(String(usdgLaunchTransaction?.value ?? "0x0"))).toBe(0n);
    expect(
      await readAllowance(
        runState,
        runState.contracts.usdg,
        runState.accounts.creator,
        runState.launcher,
      ),
    ).toBe(0n);
    expect(
      await readAllowance(
        runState,
        runState.contracts.usdg,
        runState.launcher,
        runState.contracts.swapRouter,
      ),
    ).toBe(0n);
    expect(
      await readTokenBalance(
        runState,
        runState.contracts.usdg,
        runState.launcher,
      ),
    ).toBe(0n);

    await page.goto("/launch/explore");
    await page
      .getByPlaceholder("Search name, symbol or address")
      .fill("ZUSDG");
    await expect(page.getByText("ZapPad USDG Browser").first()).toBeVisible();
    await page
      .locator(".launch-card")
      .filter({ hasText: "ZapPad USDG Browser" })
      .getByRole("link", { name: /Open token console/ })
      .click();
    await expect(
      page.getByRole("heading", { name: "ZapPad USDG Browser" }),
    ).toBeVisible();

    await page.goto("/launch/portfolio");
    await expect(page.getByText("ZapPad USDG Browser").first()).toBeVisible();
    const launch = await readLaunch(runState, usdgToken);
    expect(launch.exists).toBe(true);
    expect(launch.pairedAsset).toBe(runState.contracts.usdg);
  });
});
