# Deployment manifests

Mutable local simulations belong in this ZapPad namespace using the ignored
`*.local.json` suffix. The ignored `release-evidence/` directory is also the
narrow bridge for Foundry, whose filesystem access is restricted to
`deployments/zappad/`. Bridge artifacts are never the authoritative audit copy.

A Safe `*.local.json` becomes broadcast input only after it is copied
non-overwritably to the external audit directory, proven byte-identical, and
the authoritative external copy's exact raw-byte hash is recorded in an
independent approval and supplied as `EXPECTED_SAFE_SIMULATION_MANIFEST_HASH`.
Broadcast validation reads the byte-identical bridge from this directory before
signing and never overwrites it.

Release verification rejects standard untracked files and ignored root `.env*`
files so a local build cannot carry inputs outside the reviewed commit. Write
non-overwritable Safe, ZapPad
stack, reviewed-canary-plan, creator-broadcast, prepared-canary, hosting, and
final-canary evidence to a credential-free audit directory outside the
checkout. For a Foundry input or output, use `release-evidence/`, immediately
copy it non-overwritably to the external audit directory, and verify the two
files are byte-identical. Preserve each external artifact under a unique path
and record its exact raw-file hash before the next release step. Never commit
mutable broadcast receipts, RPC URLs,
signatures, keystores, or secrets.

ZapPad is source-ready, not deployed. A local `*.local.json`, an Anvil
broadcast, or a file in `release-evidence/` is noncanonical and must never be
presented as Robinhood Chain deployment evidence.

The hosting verifier is pinned to the OpenZaps Vercel project
`prj_uXuVv3LW0bPWfd7aHX5CLMEBbj3Q`, team
`team_Qqq9RxkmxK8LefSVmHdVo1jQ`, Git source `0pen-Zaps/openzaps`, production
branch `main`, and canonical origin `https://www.0xzaps.com`. Production must
set both `ZAPPAD_RPC_RELAY_ENABLED=true` and
`ZAPPAD_RPC_DURABLE_QUOTA_ENABLED=true`. The durable-quota flag records an
external control reviewed by the release operator; setting or verifying the
flag does not create that control.
