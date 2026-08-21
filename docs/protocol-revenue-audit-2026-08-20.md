# OpenZaps + Hookr lifetime fee-flow and protocol-revenue audit — 2026-08-20

This is a lifetime, original-asset ledger. It deliberately does not collapse
unrelated assets into a dollar total or add a token purchase's input and output
as if they were two revenues. It also separates three economically different
categories that should not be combined:

- **gross protocol fee flow** — fees routed through protocol-owned or
  protocol-directed infrastructure before their contractual allocation;
- **restricted protocol-origin allocation** — fees committed to no-drain prize
  or rewards contracts and therefore not withdrawable treasury assets; and
- **recorded protocol revenue** — the protocol fee ledger itself, excluding
  creator obligations, executor compensation, and downstream spending.

## Snapshot provenance

| Protocol | Canonical source | Chain snapshot |
|---|---|---|
| OpenZaps Base | current `origin/main` plus historical v1.0 source at `bc1ba8d` | Base block `50,242,775`, hash `0xc3694c4596f657f0f8758cb2b2fa8c0eed2fb62a74a619be39a9068a553c36e8`, 2026-08-21 01:14:57 UTC |
| OpenZaps | `origin/main` at `8316b7ccfc5636d7995c43f5917a29afe9655829` | Robinhood Chain block `41,796,234`, hash `0x9e3e77ce0a5517a4dff571c306ffed414c1f5a738cc3e8ac6616cd04ca324c30`, 2026-08-20 22:56:17 UTC |
| Hookr | `hookr-org/main` at `f765af2433dbe02d4945ce5913e927923bb24e40` plus separately identified v5 broadcast artifacts | Robinhood Chain block `41,894,119`, hash `0x4863bfaf7495ea138bc65c448f5b2f620b1d3893d0d99f0c04312e5298886360`, 2026-08-21 01:40:00 UTC |

## Economic summary

| Protocol and classification | Lifetime amount | Treasury-withdrawable? |
|---|---:|---|
| OpenZaps gross Clanker fee-share inflow | **3.018898524913195600 aeWETH** | No — contractually allocated across sponsor, governance, staking campaigns, and HookBlocks |
| OpenZaps restricted creation/execution prize allocations currently held | **489,677.994426449453392024 ZAPS** | No — no-drain pots can pay eligible users only |
| Hookr recorded core protocol revenue | **0.073128977051216528 ETH** | Yes under the versioned protocol fee ledgers; none withdrawn at snapshot |

The table is intentionally not summed across ETH, aeWETH, and ZAPS. The
OpenZaps rows describe gross fee flow and restricted allocations, not a liquid
governance balance. The Hookr row is the narrower recorded protocol-revenue
ledger.

## OpenZaps lifetime fee flows

### Base v1.0 and v1.1 — zero protocol fee flow

| Version | Factory | Complete activity scan | Protocol revenue |
|---|---|---:|---:|
| v1.0.0, superseded | `0xc7C5897e4738a157731c2F93b1d73Db9926E926C` | 0 `ZapCreated` events | **0** |
| v1.1.0, live but not app-exposed | `0x3263e547faf1d90211a92e8556bda5afce07805f` | 0 `ZapCreated` events | **0** |

The Base factories have no creation gateway, fee pot, protocol fee recipient,
or protocol fee ledger, and `createZap` is nonpayable. Their optional signed
`maxRelayerFee` is transferred by a clone directly to `intent.relayer`; it is
pass-through executor compensation, not protocol revenue without separate
proof that a protocol-controlled account received it. No clones exist in the
complete history through the snapshot, so there were also zero executions.

The superseded v1.0 factory, implementation, registry, and allowlist were
deployed at Base block `47,095,964`. The v1.1 factory was deployed at block
`48,992,188`; its registry, allowlist, three adapters, and three allowlisted
tokens were deployed/configured in blocks `48,992,186–48,992,198`. At the
snapshot, all listed v1.0/v1.1 contracts held exactly zero native ETH, WETH,
USDC, and aWETH. Base v1.2 and v2 are source-only candidates with no canonical
deployment; they are not production versions with asserted zero revenue.

### Robinhood Chain version coverage

| Version | Restricted protocol-origin allocation currently held | Notes |
|---|---:|---|
| v1.1 | 20,127.831702889014905174 ZAPS | creation-fee conversion only; direct one-shot execution fees compensate relayers |
| v1.2 | not deployed | source-only candidate, not a zero-revenue production row |
| v2 | not canonical production | excluded rather than asserted zero |
| v3 | 318,201.975813926489676741 ZAPS | creation allocation plus 20% execution pot |
| v3.1 | 101,989.064100949395604101 ZAPS | creation allocation plus 20% execution pot |
| v3.2 deployed candidate | 49,359.122808684553206008 ZAPS | creation allocation plus converted 20% execution pot |

These per-version ZAPS figures reconcile exactly to the restricted total below.

### Restricted ZAPS prize allocations — not withdrawable protocol revenue

| Source | Restricted protocol-origin amount currently held |
|---|---:|
| Eight fee-gateway creations | 125,787.312524279947469894 ZAPS |
| v3 execution 20% pots | 306,849.284460120178999196 ZAPS |
| v3.1 execution 20% pots | 57,041.396332648104107936 ZAPS |
| v3.2 protocol share, converted from 738,804 wei aeWETH | 0.001109401222814998 ZAPS |
| **Total restricted protocol-origin allocations held** | **489,677.994426449453392024 ZAPS** |

The eight creations paid `0.00008 ETH` in aggregate and atomically acquired
the 125,787.312524279947469894 ZAPS above. Those are two representations of
one flow, so the ETH input is not added again. Twenty-three earlier/direct
creations did not pass through the fee gateway.

| Fee-gateway creation version | ZAPS acquired for restricted allocation |
|---|---:|
| v1.1 | 20,127.831702889014905174 |
| v3 | 11,352.691353806310677545 |
| v3.1 | 44,947.667768301291496165 |
| v3.2 | 49,359.121699283330391010 |

Gross v3/v3.1 automation fees were
1,819,453.403963841415535601 ZAPS. The protocol's exact 20% was
363,890.680792768283107132 ZAPS; the remaining
1,455,562.723171073132428469 ZAPS belonged to executors and is excluded.
The v3.2 pot also holds 0.009664303866854436 ZAPS from a user stack; it is
excluded from the protocol-origin allocation.

These balances are protocol-origin prize/pot allocations. The deployed pots
have no governance drain and can distribute to eligible users only, so they
must not be presented as liquid protocol-owned revenue.

### aeWETH-denominated Clanker gross fee stream

| Measure | Amount |
|---|---:|
| Lifetime vault inflow, 25 FeeLocker transfers | **3.018898524913195600 aeWETH** |
| Claimed/distributed from vault | 3.016139845126740561 aeWETH |
| Current accounted vault balance | 0.002758679786455039 aeWETH |
| Upstream available fees at snapshot | 0 aeWETH |

Claimed allocations include sponsor/governance, both staking campaigns, and
HookBlocks. Campaign 2 spending of 0.026168384547665747 ETH to buy and burn
53,903.216465164823080388 HOOKR is downstream use of this fee stream, not a
second revenue line. Likewise, vault inflow is the gross stream before these
allocations, not an independently spendable treasury balance.

### Explicit OpenZaps exclusions

- Retired ZapDraw/ZapOverdraw paid 60,000 ZAPS of governance rake across two
  settled rounds, but its own documentation says it is not part of the
  protocol. It is reported here and excluded from the OpenZaps total.
- v1.2 and canonical Robinhood v2 were not production deployments. They are
  not reported as zero-revenue versions.
- Executor shares, user prize stacks, wallet principal, and downstream burns
  are not protocol revenue.

## Hookr lifetime recorded protocol revenue

| Launchpad generation / deployment | Protocol ETH accrued | Withdrawn |
|---|---:|---:|
| v1 legacy / superseded | 0.000204999906400023 | 0 |
| v2 legacy / superseded | 0.000204999906400023 | 0 |
| v3 retained / promoted | 0.071218977541616332 | 0 |
| v4 current canonical | 0.001499999696800150 | 0 |
| v5 pre-flywheel 5.0.0, abandoned / unpromoted | 0 | 0 |
| v5 flywheel-era 5.0.0, explicitly retired | 0 | 0 |
| v5 5.0.1, live bytecode / unpromoted | 0 | 0 |
| **Total** | **0.073128977051216528 ETH** | **0 ETH** |

Across 60 launches, fixed creation fees account for 0.012 ETH and recorded
curve/LP/guard/dust fees account for the remaining 0.061128977051216528 ETH.
The current protocol ledgers equal the accrued total because nothing had been
withdrawn at the snapshot.

### Explicit Hookr exclusions and boundaries

- Raw launchpad balances total 0.234622307189742527 ETH, but also contain
  creator obligations and curve reserves. They are not revenue.
- Gross creator-side accrual of 0.114602928072281704 ETH is excluded.
- v3 `PoolFeesCollected` gross volume of 0.136919621439352616 ETH is already
  split into ledgers and must not be added again.
- v4 unharvested pool fees cannot be quantified safely from the recorded
  ledgers alone. They are excluded as unknown, not asserted to be zero.
- Utility boost fees of 135.848081007928401681 HOOKR flow to stakers, not the
  protocol. The version-by-version reconstruction is reported below;
  1.999999999999999999 HOOKR was claimed and 133.848081007928401682 HOOKR
  remained reserved at the snapshot.
- The Campaign 2 HOOKR burn is an OpenZaps fee allocation, not Hookr protocol
  revenue.
- Three v5 pads have live bytecode: one abandoned pre-flywheel 5.0.0, one
  explicitly retired flywheel-era 5.0.0, and one unpromoted 5.0.1. None is in
  the canonical `hookr-org/main` release manifest at the snapshot. Their zero
  activity is reported separately rather than treated as canonical production
  usage.
- The v1 number is retained from its chain-observed fee ledger, but its source
  provenance is weaker than the canonical v2–v4 releases.

## Audit method and identity pins

Every state read used an explicit block number. Each snapshot block was fetched
again after the reads and required to retain the same hash. Event scans covered
the full deployment-to-snapshot range with the per-provider window strategy
stated below; current balances were used only as reconciliation evidence,
never as a substitute for fee-ledger or event classification.

### Base OpenZaps

The primary provider was `https://mainnet.base.org`; `1rpc.io/base` retried a
small number of block-pinned balance reads after public rate limits. Complete
`ZapCreated(address,address,bytes32,bytes32,bytes32)` scans used at most 10,000
blocks per `eth_getLogs` request. Its topic0 was
`0x7224bd5a9b5106294ccdc624700b6070892017cfdc88f4fcaff584cb669b44a0`.

| Version | Factory / implementation | Registry / allowlist |
|---|---|---|
| v1.0 | `0xc7C5897e4738a157731c2F93b1d73Db9926E926C` / `0x7c89A57A74a102d8a2A2E9e9FCF77f097216b78e` | `0x8d62b619daD575704Ba2560CF828aCab7642347F` / `0x0E6608d6b9e485550289755176173c4B6008CF12` |
| v1.1 | `0x3263e547faf1d90211a92e8556bda5afce07805f` / `0xd727023E0C408eda1537AaBb69F853B5a967A773` | `0xC0Ed9619Eb370E390B8cfFdE67D315cAF7DB4a68` / `0x5CEe32bED59Ec5C6eFb3faCFa9f0aCC7e9548AD7` |

Both factories reported nonce `2`, consistent with their constructor-created
implementation and no later clone deployment. The v1.1 adapter configuration
was independently reconciled from exactly three `AdapterSet(..., true)` and
three `TokenSet(..., true)` events. Source commits `bc1ba8d` (v1.0) and
`75f914c` (deployed v1.1) were inspected to classify direct relayer payments.

### Robinhood OpenZaps

| Role | Address |
|---|---|
| v1.1 factory | `0xFC775017b25d2458623E2f3E735A4B750dD8b4E4` |
| v3 factory / execution pot | `0x70FCFD3615eA6651a670B6c4CD6B8bA1506717e9` / `0xeB7a15CE1c969efBA43ecfc1A63960Ad0042CFe3` |
| v3.1 factory / execution pot | `0xDA5f501052fe6F87f547bc21FCAA1F122eD2f2E1` / `0x6ec3D07886Ea641e9d10D45A97a72E5f8ec836F1` |
| v3.2 factory / execution pot | `0xd9134F778E523E9CF2fD75FFCb98499E9046457B` / `0x7B8791e36f2e42FB80D209e340aE04aE94Fd411F` |
| universal creation gateway / pot | `0x02A17a94A0e2B470e931E98079Bf563c94281B2b` / `0x8E0399A8fF81a5f73Bc76CAEE8a355cF9bb0d863` |
| v3.2 creation gateway / pot | `0xa4D3bE6b97b320F1C81975038EcD5e1C5d7b3291` / `0x6a1eb88408ce53C7C9e1eb460Cc68a8BD485dC12` |
| Clanker fee-share vault / upstream FeeLocker | `0x31D6787B7C2c347Ffb5B58171e33E9c5132A7338` / `0x88db2340bE5991B2b5Fca2Baee39B5CE048Cd70c` |

Factories were scanned for `ZapCreated` to enumerate every capsule. Creation
amounts came from `CreationFeeConverted` and `StackCreationFeeConverted` logs
and were reconciled to the two no-drain creation pots. Automation amounts came
from the version-correct `ExecutedRecurring`, `ExecutedRecurringRelative`,
`ExecutedTrigger`, and `ExecutedRecurringStack` fields, then reconciled to
0xZAPS/aeWETH transfers and pot balances. The Clanker stream was derived from
the complete set of 25 aeWETH transfers directly from the pinned FeeLocker to
the vault, then reconciled to vault outflows, `accountedRewardBalance`, and the
FeeLocker's block-pinned `availableFees` read.

### Hookr launchpad identities and reproduction

The seven fee-bearing launchpad deployments below had live runtime bytecode at
the Hookr snapshot. Deployment blocks are the launchpad `CREATE` blocks, not a
surrounding multi-contract script's first transaction.

The provider was `https://rpc.mainnet.chain.robinhood.com`. Each Hookr topic
filter covered blocks `25,418,432–41,894,119` in one `eth_getLogs` request, an
inclusive maximum span of 16,475,688 blocks, restricted to the seven launchpad
addresses.

| Generation / status | Launchpad | Hook and execution helper | CREATE block / transaction | Runtime hash / source commit |
|---|---|---|---|---|
| v1 legacy / superseded | `0x27Cca38E94E3e77BFde2284325DcDb0Da7323579` | hook `0xDaf937d3B7C363e0feC29F5584ce08B0894fe088`; PoolSwapTest `0x01813Aa6c0Fc7a8Cb9dE6665e4cB28bb067aC027` | `25,418,432` / `0x6213d0db2a7720e36e198f2c54948dcb98ab158046789e3fea41ab7bd802b8cd` | `0x639fcd694c962c9d0a8671e15189e121a168741800dbba5dd9c908832fd8a08f`; first published source/artifact `ed28afd` |
| v2 legacy / superseded | `0xaa7344c210bf11d028A5298F2c57F3Ad9fA7c241` | hook `0xa9D0A2270668059D4003530a35D65C1531aaa088`; PoolSwapTest `0xC893189bb2D7258eDC9a08C8823DD85a2F71061d` | `25,489,971` / `0x737d06695408d931426f54f9842a9b7c13f84ba7c378d3c6b15d7fe688daebf9` | `0x74f6d24f70028db09e8ad2221c1b550942a149a43bb218c6a3135ace7eb1205e`; `8a4871f` |
| v3 retained / promoted | `0xaAed6fab06D53311220F35421Dda5cc6D6e9d6C3` | hook `0xd0005624Da88a688BcaB3DBFB4d1Cb23d32Ca0CC`; router `0x3f6E7BA9689d3c78A00d68931b7C223f51e0f21b` | `27,763,940` / `0x8b82df8bc55a6b7538113045d61badf30d2ae89dc9d63c57cb1f70e6b3d7ad03` | `0x433cbd64f4e003d993e55a99426efd40f11676098bebc04353ca9af9d2cfa745`; `9bec6bd850a6590e1d8b327c2734f76eb731b6de` |
| v4 current canonical | `0x5Ce779D23D2e99D322004F203813389B6a426e3B` | hook `0xa0F267571847Ce91318798578A1BCc77D77c28cC`; router `0x98F3A734860a89711e111cc692E8020Cac2A4fC5` | `33,485,079` / `0xf86e473916a3919fb4e3d842fe6a4e263b827de7b60a83afa23acbfacc47691a` | `0x433411c5613df1dd265dfac168c7f78c4cfcbe87c7ae4ab669d1ff5340d09c71`; `df6835d51d5460d4e57fee81352b18be486cb5c5` |
| v5 pre-flywheel 5.0.0, abandoned | `0x33de37a6349f6429d4667cc28fa4aa6fa0e68af9` | hook `0x26d8850efbcc6352c2edfb0cfA23127865F2e8cc`; router `0xFed1BD3E7cFf545856509A8c1628E5b26AC2a6` | `41,583,194` / `0xe2df6aae0c0e230b7b19402a4efd8e0d3409b0479ed5f2403c8efda85ec326e3` | `0xe15afe13e9bbf7102104af1f518c545e35f86e7ea4fa95828b1edbc0a0d2b6e9`; `49124f6569bf4dc153e8a23b972f2e51b68385c6` |
| v5 flywheel-era 5.0.0, retired | `0x53fD3D845058e9cE0121144eA06cBFe8eF65a1Ff` | hook `0x6096e79baA6C3AF5F2D8C9eCDD6396B78Acbe8cc`; burner `0x2D86620D4407e1070270765B675B02a3ea21399D`; router `0x8d7EC2aE0D947d67fb157a210d5Bbad19604bA8E` | `41,769,881` / `0x52e1e0548633f5fbac73e13c65b4338c419e9bf0b2b2817b0c3a6ca3795f3b48` | `0x7971818bfe2f56fbb1e496711a82c147dba661f58fb036b4d1586fd3600aca35`; `34770365825945c7ad0b33b2592509ecf5f49428` |
| v5 5.0.1, unpromoted | `0xA043cAbE645636899Dde91ccE4693c00A015E660` | hook `0xe7c3461A4c762fF9dB4F91BeE3Cf8deAaFc2E8CC`; burner `0x8cEe20FA000Af3266aC2CD2cBeEfbCd19d98fD89`; router `0x644AC2e784059E1c01f24f99DF7795aE2BE06cA0` | `41,850,162` / `0x89f3649b15def192555fdd43ebaaafde2217dafa228d1cf5d45a36c4f10a254b` | `0x26dd92acae56386f99dbc98ed2f53aa62ccff493bab27b6f1a26d84e23ed3a5d`; `b1ccb017f86d9caffff8bf4277a735d714130972` |

The exhaustive filters used these canonical signatures and topic0 values:

- v1–v4 `TokenLaunched(address,address,uint32,string,string,string,string,uint96,uint96)`:
  `0xe250d89034d6fa671d41627a41507bda3ccd0346f18a9a75265735eff1727158`;
- v5 `TokenLaunched(address,address,uint32,uint8,string,string,string,string)`:
  `0xc1bad6bddeb6746a6c7b2f4362febe4cebcb9b03ab55043d38fd1813e68d9e5d`;
- v4 `InstantLaunched(address,bytes32,uint16,uint96,uint256)`:
  `0xf2fbc14b41a21584bda77e0ba0855cb4492a425bd2842696e16a83f05c0bca70`;
- v5 `InstantLaunched(address,bytes32,uint96)`:
  `0xe4e68f29538094d634615ce44cb2c723ea42286023b0c489cb9b2b66ea80fc13`;
- v5 `AuctionStarted(address,address,uint40,uint96,uint96,uint16)`:
  `0xbc0692e08b687db813691bc9017ad266db62bf06614d2d0f860af04631b2b277`;
- `PoolFeesCollected(address,uint256,uint256)`:
  `0x251551588ab2fefc5204a992ffe52b797e42bee3b0359226b84003bece36a0b6`;
- `ProtocolFeesWithdrawn(address,uint256)`:
  `0xa087657e3d85162090ffd700fbfdf5070d816f63aa5da00063f6ffd369c8a6db`;
- `CreatorFeesClaimed(address,address,uint256)`:
  `0xaa4ecfd5324d73e3b54d038b3ae8ac8f88866d49dc334dc1f02fe36e0f935748`;
- `FeeSplitCredited(address,address,uint256)`:
  `0xa4efc9a232b77abe7f057b2d2d7bab06d8764d8b62ed3a7f0f91cde2a0f06cfd`;
- `CreationFeeSet(uint96)`:
  `0x64e836d1927fce20decf2c5818ae7f864139af12a1363a3b6c2573b85ae8b687`.

For every pad, `protocolFeesWei`, `tokensCount`, `creationFeeWei`, ownership,
name/version where available, token enumeration, raw native balance, runtime
code, and creator ledgers were read at block `41,894,119`. Runtime code was
locally hashed. Exhaustive deployment-to-snapshot log scans found launch counts
of `1 / 1 / 51 / 7 / 0 / 0 / 0`; the three v4 instant launches are a subset of
its seven total launches. No `ProtocolFeesWithdrawn(address,uint256)` event was
found on any pad. Lifetime protocol accrual is therefore the sum of the seven
current fee ledgers:

`204,999,906,400,023 + 204,999,906,400,023 +
71,218,977,541,616,332 + 1,499,999,696,800,150 + 0 + 0 + 0 =
73,128,977,051,216,528 wei`.

The scan also found 16 v3 `PoolFeesCollected` events totaling
136,919,621,439,352,616 wei, 15 `CreatorFeesClaimed` events totaling
48,315,770,226,072,402 wei, and two `FeeSplitCredited` events totaling
5,884,847,999,999 wei. These reconcile the disclosed gross/creator flows but
are not added to the protocol ledger. The predicted interrupted candidate
`0x154fda366c30cbdf30af082f08ec3f809663c3e5` had zero code and no launchpad
deployment receipt, so it is excluded. Its orphan burner is not a fee-bearing
launchpad or protocol-revenue version.

### Hookr utility rewards excluded from protocol revenue

| Utility generation | Boost / rewards contract | Gross staker rewards | Claimed | Reserved |
|---|---|---:|---:|---:|
| v1 recovery-only / superseded | `0x66a2a336f3740a22B8431e1F590a406aB89dD54c` / `0x62e282555F43cba2Fec5A36c6fF821421dd06878` | 0 HOOKR | 0 | 0 |
| v2 deployed | `0xb5cc450A1529A7CA3127C9065EFFa76144502BA5` / `0x33f725e4a5094eDE37445A76bd96Ac9C8da94586` | 134.848081007928401681 HOOKR | 1 HOOKR | 133.848081007928401681 HOOKR |
| v3 deployed candidate | `0x252CF025D8823DfbBA9E4B0830c4d3ECe8341548` / `0x81d57cBffc41b81708A05195C23Bb192711B5c47` | 1 HOOKR | 0.999999999999999999 HOOKR | 0.000000000000000001 HOOKR |
| **Total** |  | **135.848081007928401681 HOOKR** | **1.999999999999999999 HOOKR** | **133.848081007928401682 HOOKR** |

These amounts were reconstructed from the complete zero-initialized reward
notification and claim event accumulators through the Hookr snapshot. The
public Robinhood RPC returned `metadata is not found` for historical
`eth_call` at that block, so current getters were used only as corroboration:
they matched the reconstruction, and no later accounting event was observed
through block `41,913,601`. Each address/topic scan was a single
`eth_getLogs` request; the largest interval was
`25,418,432–41,894,119`, or 16,475,688 blocks inclusive. These contracts
allocate HOOKR to utility stakers and are not launchpad protocol-fee ledgers,
so none of the table is included in the 0.073128977051216528 ETH total.
