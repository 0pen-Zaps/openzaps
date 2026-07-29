import { RelayQueryError } from "@/lib/relay-server";

const DEFAULT_PAGE_LIMIT = 25;
const MAX_PAGE_LIMIT = 50;

export function agentConnectionsPageLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_PAGE_LIMIT;
  if (!/^[0-9]{1,2}$/.test(raw)) {
    throw new RelayQueryError("limit", `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`);
  }
  const limit = Number(raw);
  if (limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new RelayQueryError("limit", `limit must be an integer from 1 to ${MAX_PAGE_LIMIT}.`);
  }
  return limit;
}
