# ZapPad security and legal posture

ZapPad is experimental, pre-audit financial software. Public source, passing
tests, source verification, a healthy runtime, or a low-value canary does not
make it safe, audited, legally approved, or suitable for material funds.

## Economic disclosure

Each `ZapFeeVault` permanently holds one Uniswap v3 LP NFT. Its 100
transferable fee-share ERC-20s encode pro-rata rights to LP fees collected and
checkpointed by that vault.

Those fee-share tokens:

- are not 0xZAPS;
- are not shares, equity, ownership, or governance in OpenZaps;
- are not rights to OpenZaps-wide fees, revenue, treasury assets, or future
  products;
- do not guarantee that trading occurs, fees accrue, fees are harvested, the
  assets retain value, or a holder earns any return;
- are not a redemption promise, deposit account, brokerage product, or
  investment recommendation.

The initial 80/20 split describes ownership of that vault's fee-share supply,
not an estimate of yield. The pool fee tier is the trader fee and is not a
guaranteed net yield. Uniswap governance may change protocol fees, and token,
liquidity, gas, MEV, tax, and legal conditions may change.

Transferable LP fee rights may be regulated differently by jurisdiction.
Before activation, specialist counsel must review securities, broker-dealer,
money-transmission, sanctions, financial-promotion, tax, consumer-protection,
privacy, and token-moderation obligations.

## Robinhood non-affiliation

OpenZaps and ZapPad are independent software. They are not affiliated with,
endorsed by, sponsored by, or operated by Robinhood Markets, Inc. or its
affiliates. “Robinhood Chain” identifies the network only. ZapPad does not
imply a Robinhood brokerage listing, distribution arrangement, approval, or
relationship, and it does not use Robinhood logos.

The initial feature excludes Robinhood Stock Token pairs. A permissionless
launch must never be presented as official equity, debt, a security issued by
Robinhood, a guaranteed return, or an official Robinhood product.

## Protocol invariants

- Every launch token has fixed supply and no owner, transfer tax, pause, or
  post-deployment mint authority.
- Only canonical WETH and USDG are paired assets.
- Only factory-enabled 0.05%, 0.3%, and 1% Uniswap v3 tiers are accepted.
- The LP NFT is minted to the vault and cannot be transferred or decreased by
  any ZapPad method.
- Fee-share supply is exactly 100, atomically split 80/20 before accounting
  activates.
- Harvest is permissionless, share transfers do not call Uniswap, and claims
  cannot exceed checkpointed entitlement or actual vault balances.
- After one-time factory binding, no deployer, OpenZaps operator, agent,
  executor, backend, or treasury can upgrade or administer the launchpad.

## Residual risks

- **No independent external audit.** Material-value or promoted public use must
  wait for one.
- **Checkpoint timing.** Uncollected position fees are allocated when harvest
  checkpoints them, not at every underlying swap block. A holder may transfer
  around a checkpoint.
- **Pool griefing.** A mempool observer can pre-initialize a predicted pool and
  force a salt to be replaced. This is censorship/griefing, not authority over
  the token, supply, fee shares, or LP NFT.
- **Upgradeable dependencies.** WETH and USDG are external proxies. The app
  pins their implementations and fails closed on drift, but direct onchain
  callers are not paused by the app.
- **External systems.** Robinhood Chain, Uniswap, wallets, private submission,
  explorers, and RPC providers may fail, censor, reorganize, or change.
- **Market and MEV risk.** Prices, liquidity, volatility, slippage, sandwiching,
  gas, and token behavior can cause partial or total loss.
- **Accounting dust.** Bounded base-unit rounding dust may remain.
- **Key and Safe risk.** Compromised creator wallets or Safe owners can lose
  their own tokens or fee shares. The protocol does not recover them.
- **Interface versus chain.** Disabling OpenZaps writes does not pause immutable
  contracts once deployed.

## Current activation gate

There are no approved ZapPad mainnet addresses. Writes remain disabled until
the exact OpenZaps SHA completes external security review or documented canary
risk acceptance, counsel approval, fresh 2-of-3 Safe deployment, fresh stack
deployment, full source and receipt verification, low-value WETH/USDG canary,
final Safe claims, paid RPC and firewall controls, exact-SHA Production
verification, and a recorded go/no-go.

See [release.md](release.md) for the evidence chain. Do not treat a predicted
address, local fork, simulation manifest, source-ready interface, or Preview as
a deployed protocol.

## Vulnerability reporting

Do not open a public issue for an exploitable vulnerability. Use GitHub private
vulnerability reporting for the OpenZaps repository, include the affected full
commit and any deployed address, and provide impact plus a minimal proof of
concept. Never send a private key or seed phrase.
