import type { Address } from "viem";
import { describe, expect, it } from "vitest";

import {
  allowanceAuthorityKey,
  ownerAllowances,
  recordSpenderAllowance,
  spenderAllowance,
  type SpenderAllowance,
} from "./launch-studio";
import { protocolSnapshotScope } from "./protocol-snapshot";

const LAUNCHER_A =
  "0x1000000000000000000000000000000000000001" as Address;
const LAUNCHER_B =
  "0x2000000000000000000000000000000000000002" as Address;
const OWNER_A =
  "0xa000000000000000000000000000000000000001" as Address;
const OWNER_B =
  "0xb000000000000000000000000000000000000002" as Address;

describe("ZapPad owner-and-spender-scoped allowances", () => {
  it("does not reinterpret launcher A's amount as an allowance for launcher B", () => {
    let allowances: SpenderAllowance[] = [];
    allowances = recordSpenderAllowance(
      allowances,
      OWNER_A,
      LAUNCHER_A,
      25_000_000n,
    );

    // A verified zero for the newly active launcher must not create a B revoke
    // target or discard the still-nonzero allowance previously verified for A.
    allowances = recordSpenderAllowance(
      allowances,
      OWNER_A,
      LAUNCHER_B,
      0n,
    );

    expect(spenderAllowance(allowances, OWNER_A, LAUNCHER_B)).toBeNull();
    expect(spenderAllowance(allowances, OWNER_A, LAUNCHER_A)).toEqual({
      owner: OWNER_A,
      spender: LAUNCHER_A,
      amount: 25_000_000n,
    });
  });

  it("retains multiple nonzero spenders and removes only the one verified at zero", () => {
    let allowances = recordSpenderAllowance(
      [],
      OWNER_A,
      LAUNCHER_A,
      25_000_000n,
    );
    allowances = recordSpenderAllowance(
      allowances,
      OWNER_A,
      LAUNCHER_B,
      10_000_000n,
    );

    expect(allowances).toHaveLength(2);

    // This is the state transition after a receipt-backed approve(A, 0) and
    // exact A readback. B remains independently visible and revocable.
    allowances = recordSpenderAllowance(
      allowances,
      OWNER_A,
      LAUNCHER_A,
      0n,
    );

    expect(spenderAllowance(allowances, OWNER_A, LAUNCHER_A)).toBeNull();
    expect(spenderAllowance(allowances, OWNER_A, LAUNCHER_B)).toEqual({
      owner: OWNER_A,
      spender: LAUNCHER_B,
      amount: 10_000_000n,
    });
  });

  it("keys owners and spenders case-insensitively without duplicating authority", () => {
    const uppercaseA = LAUNCHER_A.toUpperCase() as Address;
    const uppercaseOwner = OWNER_A.toUpperCase() as Address;
    let allowances = recordSpenderAllowance(
      [],
      OWNER_A,
      LAUNCHER_A,
      1n,
    );
    allowances = recordSpenderAllowance(
      allowances,
      uppercaseOwner,
      uppercaseA,
      2n,
    );

    expect(allowances).toEqual([
      { owner: uppercaseOwner, spender: uppercaseA, amount: 2n },
    ]);
    expect(spenderAllowance(allowances, OWNER_A, LAUNCHER_A)?.amount).toBe(2n);
  });

  it("does not expose or mutate owner A authority after switching to owner B", () => {
    let allowances = recordSpenderAllowance(
      [],
      OWNER_A,
      LAUNCHER_A,
      25_000_000n,
    );
    expect(ownerAllowances(allowances, OWNER_B)).toEqual([]);

    allowances = recordSpenderAllowance(
      allowances,
      OWNER_B,
      LAUNCHER_A,
      10_000_000n,
    );

    expect(spenderAllowance(allowances, OWNER_B, LAUNCHER_A)).toEqual({
      owner: OWNER_B,
      spender: LAUNCHER_A,
      amount: 10_000_000n,
    });
    expect(ownerAllowances(allowances, OWNER_B)).toEqual([
      {
        owner: OWNER_B,
        spender: LAUNCHER_A,
        amount: 10_000_000n,
      },
    ]);

    allowances = recordSpenderAllowance(
      allowances,
      OWNER_B,
      LAUNCHER_A,
      0n,
    );

    expect(spenderAllowance(allowances, OWNER_B, LAUNCHER_A)).toBeNull();
    expect(spenderAllowance(allowances, OWNER_A, LAUNCHER_A)).toEqual({
      owner: OWNER_A,
      spender: LAUNCHER_A,
      amount: 25_000_000n,
    });
    expect(allowanceAuthorityKey(OWNER_A, LAUNCHER_A)).not.toBe(
      allowanceAuthorityKey(OWNER_B, LAUNCHER_A),
    );
  });
});

describe("ZapPad protocol snapshot scope", () => {
  it("uses a different mounted state scope for null and every launcher", () => {
    expect(protocolSnapshotScope(null)).toBe("unavailable");
    expect(protocolSnapshotScope(LAUNCHER_A)).not.toBe(
      protocolSnapshotScope(LAUNCHER_B),
    );
    expect(protocolSnapshotScope(LAUNCHER_A)).not.toBe(
      protocolSnapshotScope(null),
    );
  });
});
