# ADR-0004: Protective vs Optimization Zaps & Trigger Model

**Status:** Accepted
**Date:** 2026-06-06
**Deciders:** Product (Nodar) · Smart-contract lead · Security/audit lead

## Context

The research report's threat matrix treats *triggering* uniformly, but zaps fall into two
economically distinct classes:

- **Optimization zaps** (rebalance, harvest, compound): a missed trigger costs **efficiency**.
- **Protective zaps** (collateral top-up before liquidation, auto-deleverage): a missed trigger
  costs **principal**, and the failure is **silent**.

A single off-chain Hermes is an availability **single point of failure**. If it is down, censored,
compromised, or stuck behind a **Base sequencer outage**, the protective class fails precisely when
markets are moving — with no signal to the user. This also collides with ADR-0003: protective
triggers genuinely want *permissionless, on-chain-conditioned* execution, which forecloses the
privacy that ADR-0003 reserves for price-sensitive routes.

Separately, the report's Hermes prompt requires multi-RPC quorum but says nothing about **L2
finality/reorg** — on an L2, inclusion is not finality, and a sequencer outage fails *all* zaps at
once.

## Decision

1. **v1 ships OPTIMIZATION zaps only.** They are triggered by a single-submitter Hermes (using
   multi-builder private submission per ADR-0003). Missing a trigger is non-catastrophic *by
   construction*, so a single submitter is acceptable.

2. **PROTECTIVE / liquidation-sensitive zaps are DEFERRED from v1.** When introduced (dedicated
   v1.x ADR), they MUST use a different trigger model:
   - **Permissionless triggering gated by an on-chain condition** (e.g., read the health factor from
     the lending protocol) so **any** keeper can fire when the condition is met — removing the
     single-agent SPOF — while **explicitly accepting MEV exposure** on that route as the price of
     safety. This scopes ADR-0003's tension cleanly: *protective ⇒ permissionless + public;
     optimization ⇒ private.*
   - A defined **L2 finality / sequencer-outage policy**, including evaluation of an **L1
     force-include escape hatch**; protective zaps must never assume the sequencer is up.

3. **L2 finality for all zaps:** treat **inclusion ≠ finality** for high-value optimization zaps.
   Hermes monitors to L1 finality before treating a high-value zap as settled (extends the report's
   multi-RPC quorum requirement).

4. **The factory enforces the v1 boundary:** only optimization-class policies are admissible in v1.

## Options Considered

### Option A: v1 = optimization-only; defer protective *(recommended)*
| Dimension | Assessment |
|-----------|------------|
| Principal safety | **High** — no principal-protective feature shipped on a single-agent assumption |
| Liveness requirement | Non-critical (missing a trigger costs efficiency) |
| MEV | Private submission viable everywhere (ADR-0003) |
| Scope / time-to-ship | Narrow surface; smaller audit |

**Pros:** Honest security story; private submission stays coherent; smaller attack surface.
**Cons:** The flashiest use case (auto-deleverage) waits for v1.x.

### Option B: Include protective now, with permissionless on-chain triggers
| Dimension | Assessment |
|-----------|------------|
| Principal safety | High *if* the on-chain condition + escape hatch are correct |
| MEV | Accepts exposure on protective routes |
| Scope | **Large** — adds keeper economics, oracle/condition logic, sequencer-outage handling |

**Pros:** Ships the high-value feature.
**Cons:** Substantially expands v1 scope and audit surface before the core is proven.

### Option C: Include protective on single-submitter Hermes
**Rejected.** A silent, principal-loss SPOF — the worst failure shape for a safety feature.

## Trade-off Analysis

Deferring protective zaps narrows the launch surface (good for both the security story and the
audit) and avoids the cardinal error of shipping a principal-*protective* feature on an availability
assumption that cannot hold (single agent; single sequencer). The cost is purely product timing: the
most exciting use case moves to v1.x, where it can be built on the trigger model it actually
requires — permissionless, on-chain-conditioned, MEV-accepting, sequencer-outage-aware — rather than
retrofitted onto an optimization-grade submission path. Option B is viable but front-loads a large
scope expansion onto an unproven core. Option C is unacceptable on its face.

## Consequences

**Easier:** v1 liveness requirements are non-critical, so single-submitter Hermes + multi-builder
private submission is sufficient; the audit scope stays tight.

**Harder:** the factory must classify and gate policies (optimization vs protective); "what counts
as protective" needs a crisp, enforceable rule.

**Revisit:** a dedicated **v1.x ADR** for permissionless on-chain-conditioned protective triggers and
the sequencer-outage / L1 force-include escape hatch.

## Action Items

1. [ ] Define the classification rule: a zap is **protective** if its action prevents a loss/liquidation; **optimization** if it merely improves a position.
2. [ ] Factory rejects or segregates protective-class policies in v1 (invariant **I-SUB-2**).
3. [ ] Hermes: finality-aware monitoring for high-value zaps; explicit sequencer-down handling.
4. [ ] Backlog: v1.x ADR for protective-zap trigger model (permissionless on-chain conditions + L1 escape hatch).
5. [ ] Get sign-off that auto-deleverage / liquidation-protection is explicitly a post-v1 feature.
