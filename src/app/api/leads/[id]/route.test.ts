import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/leads/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/leads/server")>()),
  deleteLeadRequest: vi.fn(),
  updateLeadRequestLifecycle: vi.fn(),
}));

import {
  deleteLeadRequest,
  LeadStoreError,
  updateLeadRequestLifecycle,
} from "@/lib/leads/server";
import { DELETE, PATCH } from "./route";

const LEAD_ID = "019fab5e-be72-72d2-809b-0a1d4a35c86b";
const ADMIN_TOKEN = "l".repeat(32);
const mockedDelete = vi.mocked(deleteLeadRequest);
const mockedUpdate = vi.mocked(updateLeadRequestLifecycle);

function context(id = LEAD_ID) {
  return { params: Promise.resolve({ id }) };
}

function request(
  method: "PATCH" | "DELETE",
  body?: unknown,
  token = ADMIN_TOKEN,
): Request {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (body !== undefined) headers.set("content-type", "application/json");
  return new Request(`https://www.0xzaps.com/api/leads/${LEAD_ID}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("PATCH /api/leads/[id]", () => {
  it("requires the lead-desk credential before reading or mutating a lead", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", ADMIN_TOKEN);

    const response = await PATCH(
      request("PATCH", { status: "contacted" }, "wrong"),
      context(),
    );

    expect(response.status).toBe(401);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("applies a bounded lifecycle transition and returns no network data", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", ADMIN_TOKEN);
    mockedUpdate.mockResolvedValue({
      result: "updated",
      id: LEAD_ID,
      status: "qualified",
      updatedAt: "2026-07-30T03:00:00.000Z",
      expiresAt: "2027-01-26T03:00:00.000Z",
    });

    const response = await PATCH(
      request("PATCH", { status: "qualified" }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockedUpdate).toHaveBeenCalledWith(LEAD_ID, "qualified");
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({
      lead: {
        id: LEAD_ID,
        status: "qualified",
        updatedAt: "2026-07-30T03:00:00.000Z",
        expiresAt: "2027-01-26T03:00:00.000Z",
      },
    });
    expect(raw).not.toMatch(/fingerprint|network|ip[_-]?address/iu);
  });

  it("rejects malformed bodies and invalid or expired transitions", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", ADMIN_TOKEN);

    expect((
      await PATCH(request("PATCH", { status: "new", extra: true }), context())
    ).status).toBe(400);
    expect(mockedUpdate).not.toHaveBeenCalled();

    mockedUpdate.mockResolvedValueOnce({ result: "invalid_transition" });
    expect((
      await PATCH(request("PATCH", { status: "new" }), context())
    ).status).toBe(409);

    mockedUpdate.mockResolvedValueOnce({ result: "expired" });
    expect((
      await PATCH(request("PATCH", { status: "closed" }), context())
    ).status).toBe(404);
  });

  it("fails closed when storage is unavailable", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", ADMIN_TOKEN);
    mockedUpdate.mockRejectedValue(new Error("database unavailable"));

    const response = await PATCH(
      request("PATCH", { status: "contacted" }),
      context(),
    );

    expect(response.status).toBe(503);
  });
});

describe("DELETE /api/leads/[id]", () => {
  it("deletes only through the lead-desk credential", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", ADMIN_TOKEN);
    mockedDelete.mockResolvedValue(true);

    expect((
      await DELETE(request("DELETE", undefined, "wrong"), context())
    ).status).toBe(401);
    expect(mockedDelete).not.toHaveBeenCalled();

    const response = await DELETE(request("DELETE"), context());
    expect(response.status).toBe(204);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mockedDelete).toHaveBeenCalledWith(LEAD_ID);
    expect(await response.text()).toBe("");
  });

  it("returns not found and validates the deletion target", async () => {
    vi.stubEnv("OPENZAPS_LEAD_ADMIN_TOKEN", ADMIN_TOKEN);
    mockedDelete.mockResolvedValueOnce(false);
    expect((
      await DELETE(request("DELETE"), context())
    ).status).toBe(404);

    mockedDelete.mockRejectedValueOnce(
      new LeadStoreError("invalid-input", "invalid id"),
    );
    expect((
      await DELETE(request("DELETE"), context("not-a-uuid"))
    ).status).toBe(400);
  });
});
