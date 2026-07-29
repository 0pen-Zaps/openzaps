export class SupersededRequestError extends Error {
  constructor() {
    super("A newer request superseded this result.");
    this.name = "SupersededRequestError";
  }
}

export interface LatestRequestTicket {
  isCurrent: () => boolean;
  settle: <T>(request: Promise<T>) => Promise<T>;
}

/**
 * Prevents an older asynchronous response from being consumed after a newer
 * request (or an explicit invalidation) has become authoritative.
 */
export class LatestRequestGate {
  private version = 0;

  begin(): LatestRequestTicket {
    const version = ++this.version;
    const isCurrent = () => version === this.version;
    return {
      isCurrent,
      settle: async <T>(request: Promise<T>) => {
        const value = await request;
        if (!isCurrent()) throw new SupersededRequestError();
        return value;
      },
    };
  }

  invalidate() {
    this.version += 1;
  }
}

export function isSupersededRequest(
  reason: unknown,
): reason is SupersededRequestError {
  return reason instanceof SupersededRequestError;
}
