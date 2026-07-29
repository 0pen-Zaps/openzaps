# OpenZaps Architecture Decision Records

ADRs capture significant, hard-to-reverse design decisions with their context, the options
considered, and the consequences. They are the durable record of *why* the system is shaped the
way it is.

The first four ADRs derive from the v1 design evaluation of [`../research-report.md`](../research-report.md).
Later records preserve equally consequential production decisions without rewriting those accepted foundations.

| ADR | Title | Status | Resolves |
|---|---|---|---|
| [0001](0001-authority-model-and-policy-binding.md) | Authority Model & Policy Binding | Accepted | Where authority lives; generic-verifier vs immutable-per-zap |
| [0002](0002-deployment-and-instance-isolation.md) | Deployment & Instance Isolation | Accepted | Clone shared-implementation blast radius |
| [0003](0003-submission-privacy-vs-censorship.md) | Submission — Privacy vs Censorship Resistance | Accepted | Private-by-default vs permissionless fallback contradiction |
| [0004](0004-protective-vs-optimization-zaps.md) | Protective vs Optimization Zaps & Trigger Model | Accepted | Single-submitter liveness SPOF; L2 finality |
| [0005](0005-universal-creation-fee-gateway.md) | Universal app-creation fee gateway | Accepted | Visible fee conversion without replacing live capsule lineages |
| [0006](0006-agent-connection-and-mcp-surface.md) | An agent connection is an executor pin, not a credential | Accepted | How an AI agent is given a Zap without being given authority |
| [0007](0007-irreversible-owner-policy-halt.md) | Irreversible owner-scoped policy halt | Accepted | Permanent per-policy revocation without shared or reversible admin authority |

Testable invariants derived from these decisions live in
[`../invariant-spec.md`](../invariant-spec.md).

## Status lifecycle

`Proposed → Accepted → (Deprecated | Superseded by ADR-NNNN)`

All records above are **Accepted**. The implementation in [`../../contracts/`](../../contracts) is built against
them; any change to an accepted decision must be a new superseding ADR, not an edit.

## Conventions

- One decision per ADR. Number sequentially, zero-padded (`0005-...`).
- Never rewrite an accepted ADR's decision — supersede it with a new ADR and link both ways.
- Cross-reference the research report and the invariant spec by section/ID so claims are traceable.
